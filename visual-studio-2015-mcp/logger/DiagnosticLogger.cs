using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Build.Framework;

namespace Vs2015.Diagnostics
{
    // This assembly deliberately implements ILogger directly. It needs only
    // Microsoft.Build.Framework 14 and .NET Framework runtime assemblies.
    public sealed class DiagnosticLogger : ILogger
    {
        private readonly object gate = new object();
        private readonly DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(LogRecord));
        private readonly Dictionary<string, DateTime> starts = new Dictionary<string, DateTime>();
        private StreamWriter writer;
        private IEventSource source;
        private long sequence;
        private long eventsWritten;
        private long droppedEvents;
        private long droppedDiagnostics;
        private long truncatedMessages;
        private long truncatedDiagnosticMessages;
        private long errorCount;
        private long warningCount;
        private int maxEvents = 100000;
        private int maxMessageChars = 32768;
        private bool timings;
        private bool buildFinished;
        private bool buildSucceeded;
        private bool failed;
        private bool closed;

        public LoggerVerbosity Verbosity { get; set; }
        public string Parameters { get; set; }

        public DiagnosticLogger() { Verbosity = LoggerVerbosity.Normal; }

        public void Initialize(IEventSource eventSource)
        {
            if (eventSource == null) throw new LoggerException("Diagnostics logger requires an event source.");
            if (writer != null) throw new LoggerException("Diagnostics logger was initialized twice.");
            try
            {
                string output = ParseParameters();
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                // Never replace another run's log, even if a client reused its path.
                writer = new StreamWriter(new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
                writer.AutoFlush = true;
                Write(new LogRecord { kind = "sessionStarted", timestampUtc = Utc(DateTime.UtcNow), maxEvents = maxEvents,
                    maxMessageChars = maxMessageChars, timings = timings }, true);
                source = eventSource;
                source.BuildStarted += OnBuildStarted;
                source.BuildFinished += OnBuildFinished;
                source.ErrorRaised += OnError;
                source.WarningRaised += OnWarning;
                if (timings)
                {
                    source.ProjectStarted += OnProjectStarted;
                    source.ProjectFinished += OnProjectFinished;
                    source.TargetStarted += OnTargetStarted;
                    source.TargetFinished += OnTargetFinished;
                }
            }
            catch (Exception exception)
            {
                failed = true;
                if (writer != null) { try { writer.Dispose(); } catch { } writer = null; }
                if (exception is LoggerException) throw;
                throw new LoggerException("Diagnostics logger initialization failed: " + exception.Message, exception);
            }
        }

        private string ParseParameters()
        {
            string output = null;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string part in (Parameters ?? "").Split(';'))
            {
                int separator = part.IndexOf('=');
                if (separator <= 0) throw new LoggerException("Invalid diagnostics logger parameter.");
                string key = part.Substring(0, separator).Trim();
                string value = part.Substring(separator + 1);
                if (!seen.Add(key)) throw new LoggerException("Duplicate diagnostics logger parameter: " + key);
                switch (key.ToLowerInvariant())
                {
                    case "output":
                        output = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(value));
                        break;
                    case "maxevents": maxEvents = ParseLimit(value, 1, 1000000, key); break;
                    case "maxmessagechars": maxMessageChars = ParseLimit(value, 64, 1048576, key); break;
                    case "timings":
                        if (!Boolean.TryParse(value, out timings)) throw new LoggerException("timings must be true or false.");
                        break;
                    default: throw new LoggerException("Unknown diagnostics logger parameter: " + key);
                }
            }
            if (String.IsNullOrEmpty(output)) throw new LoggerException("output must contain a base64 UTF-8 absolute file path.");
            string root = Path.GetPathRoot(output);
            if (String.IsNullOrEmpty(root) || root.Length <= 1 || (root.Length == 2 && root[1] == ':'))
                throw new LoggerException("Diagnostics output path must be fully qualified.");
            if (output.IndexOf('\0') >= 0) throw new LoggerException("Diagnostics output path contains NUL.");
            return Path.GetFullPath(output);
        }

        private static int ParseLimit(string value, int minimum, int maximum, string name)
        {
            int result;
            if (!Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out result) || result < minimum || result > maximum)
                throw new LoggerException(name + " is outside its supported range.");
            return result;
        }

        private static string Utc(DateTime value) { return value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture); }

        private LogRecord Event(string kind, BuildEventArgs args)
        {
            return new LogRecord { kind = kind, timestampUtc = Utc(args.Timestamp), message = args.Message,
                context = EventContext.From(args.BuildEventContext) };
        }

        private void OnBuildStarted(object sender, BuildStartedEventArgs args)
        {
            lock (gate) { Write(Event("buildStarted", args), true); }
        }

        private void OnBuildFinished(object sender, BuildFinishedEventArgs args)
        {
            lock (gate)
            {
                buildFinished = true;
                buildSucceeded = args.Succeeded;
                var record = Event("buildFinished", args);
                record.succeeded = args.Succeeded;
                record.errorCount = errorCount;
                record.warningCount = warningCount;
                Write(record, true);
            }
        }

        private void OnError(object sender, BuildErrorEventArgs args)
        {
            lock (gate)
            {
                errorCount++;
                var record = Event("error", args);
                Diagnostic(record, args.Code, args.File, args.LineNumber, args.ColumnNumber, args.EndLineNumber, args.EndColumnNumber, args.ProjectFile, args.Subcategory);
                Write(record, false);
            }
        }

        private void OnWarning(object sender, BuildWarningEventArgs args)
        {
            lock (gate)
            {
                warningCount++;
                var record = Event("warning", args);
                Diagnostic(record, args.Code, args.File, args.LineNumber, args.ColumnNumber, args.EndLineNumber, args.EndColumnNumber, args.ProjectFile, args.Subcategory);
                Write(record, false);
            }
        }

        private static void Diagnostic(LogRecord record, string code, string file, int line, int column, int endLine, int endColumn, string project, string subcategory)
        {
            record.code = code; record.file = file; record.line = line; record.column = column;
            record.endLine = endLine; record.endColumn = endColumn; record.project = project; record.subcategory = subcategory;
        }

        private static string TimingKey(string kind, BuildEventContext context)
        {
            if (context == null) return null;
            return kind + ":" + context.SubmissionId + ":" + context.NodeId + ":" + context.ProjectContextId + ":" +
                context.ProjectInstanceId + (kind == "target" ? ":" + context.TargetId : "");
        }

        private void StartTiming(string kind, BuildEventArgs args, LogRecord record)
        {
            // Never let optional timing state grow beyond the event budget.
            string key = TimingKey(kind, args.BuildEventContext);
            if (key != null && starts.Count < maxEvents) starts[key] = args.Timestamp;
            Write(record, false);
        }

        private void FinishTiming(string kind, BuildEventArgs args, LogRecord record)
        {
            string key = TimingKey(kind, args.BuildEventContext);
            DateTime started;
            if (key != null && starts.TryGetValue(key, out started))
            {
                double elapsed = (args.Timestamp - started).TotalMilliseconds;
                if (elapsed >= 0) record.durationMs = elapsed;
                starts.Remove(key);
            }
            Write(record, false);
        }

        private void OnProjectStarted(object sender, ProjectStartedEventArgs args)
        {
            lock (gate) { var record = Event("projectStarted", args); record.project = args.ProjectFile; StartTiming("project", args, record); }
        }
        private void OnProjectFinished(object sender, ProjectFinishedEventArgs args)
        {
            lock (gate) { var record = Event("projectFinished", args); record.project = args.ProjectFile; record.succeeded = args.Succeeded; FinishTiming("project", args, record); }
        }
        private void OnTargetStarted(object sender, TargetStartedEventArgs args)
        {
            lock (gate) { var record = Event("targetStarted", args); record.project = args.ProjectFile; record.target = args.TargetName; record.file = args.TargetFile; StartTiming("target", args, record); }
        }
        private void OnTargetFinished(object sender, TargetFinishedEventArgs args)
        {
            lock (gate) { var record = Event("targetFinished", args); record.project = args.ProjectFile; record.target = args.TargetName; record.file = args.TargetFile; record.succeeded = args.Succeeded; FinishTiming("target", args, record); }
        }

        private void Write(LogRecord record, bool essential)
        {
            if (failed || closed) throw new LoggerException("Diagnostics logging is no longer available.");
            bool diagnostic = record.kind == "error" || record.kind == "warning";
            if (!essential && eventsWritten >= maxEvents)
            {
                droppedEvents++;
                if (diagnostic) droppedDiagnostics++;
                return;
            }
            if (record.message != null && record.message.Length > maxMessageChars)
            {
                int length = maxMessageChars;
                if (length > 0 && Char.IsHighSurrogate(record.message[length - 1])) length--;
                record.message = record.message.Substring(0, length);
                record.messageTruncated = true;
                truncatedMessages++;
                if (diagnostic) truncatedDiagnosticMessages++;
            }
            record.schemaVersion = 1;
            record.sequence = ++sequence;
            try
            {
                using (var buffer = new MemoryStream())
                {
                    serializer.WriteObject(buffer, record);
                    writer.WriteLine(Encoding.UTF8.GetString(buffer.ToArray()));
                }
                eventsWritten++;
            }
            catch (Exception exception)
            {
                failed = true;
                throw new LoggerException("Diagnostics logger could not write a complete record: " + exception.Message, exception);
            }
        }

        public void Shutdown()
        {
            lock (gate)
            {
                if (closed) return;
                if (source != null)
                {
                    source.BuildStarted -= OnBuildStarted; source.BuildFinished -= OnBuildFinished;
                    source.ErrorRaised -= OnError; source.WarningRaised -= OnWarning;
                    source.ProjectStarted -= OnProjectStarted; source.ProjectFinished -= OnProjectFinished;
                    source.TargetStarted -= OnTargetStarted; source.TargetFinished -= OnTargetFinished;
                }
                try
                {
                    if (writer != null && !failed)
                    {
                        Write(new LogRecord { kind = "sessionFinished", timestampUtc = Utc(DateTime.UtcNow),
                            buildFinishedObserved = buildFinished, succeeded = buildFinished ? (bool?)buildSucceeded : null,
                            errorCount = errorCount, warningCount = warningCount, eventsWritten = eventsWritten + 1,
                            droppedEvents = droppedEvents, droppedDiagnostics = droppedDiagnostics,
                            truncatedMessages = truncatedMessages,
                            diagnosticsComplete = buildFinished && droppedDiagnostics == 0 && truncatedDiagnosticMessages == 0 }, true);
                    }
                }
                finally
                {
                    closed = true;
                    if (writer != null)
                    {
                        try { writer.Dispose(); }
                        catch (Exception exception) { throw new LoggerException("Diagnostics logger could not close its output: " + exception.Message, exception); }
                        finally { writer = null; }
                    }
                }
            }
        }
    }

    [DataContract]
    internal sealed class EventContext
    {
        [DataMember] public int nodeId;
        [DataMember] public int projectContextId;
        [DataMember] public int projectInstanceId;
        [DataMember] public int targetId;
        [DataMember] public int taskId;
        [DataMember] public int submissionId;
        internal static EventContext From(BuildEventContext value)
        {
            if (value == null) return null;
            return new EventContext { nodeId = value.NodeId, projectContextId = value.ProjectContextId,
                projectInstanceId = value.ProjectInstanceId, targetId = value.TargetId, taskId = value.TaskId, submissionId = value.SubmissionId };
        }
    }

    [DataContract]
    internal sealed class LogRecord
    {
        [DataMember] public int schemaVersion;
        [DataMember] public long sequence;
        [DataMember] public string kind;
        [DataMember] public string timestampUtc;
        [DataMember(EmitDefaultValue = false)] public string message;
        [DataMember(EmitDefaultValue = false)] public bool messageTruncated;
        [DataMember(EmitDefaultValue = false)] public EventContext context;
        [DataMember(EmitDefaultValue = false)] public string code;
        [DataMember(EmitDefaultValue = false)] public string file;
        [DataMember(EmitDefaultValue = false)] public string project;
        [DataMember(EmitDefaultValue = false)] public string subcategory;
        [DataMember(EmitDefaultValue = false)] public string target;
        [DataMember(EmitDefaultValue = false)] public int? line;
        [DataMember(EmitDefaultValue = false)] public int? column;
        [DataMember(EmitDefaultValue = false)] public int? endLine;
        [DataMember(EmitDefaultValue = false)] public int? endColumn;
        [DataMember(EmitDefaultValue = false)] public double? durationMs;
        [DataMember(EmitDefaultValue = false)] public bool? succeeded;
        [DataMember(EmitDefaultValue = false)] public bool? buildFinishedObserved;
        [DataMember(EmitDefaultValue = false)] public bool? diagnosticsComplete;
        [DataMember(EmitDefaultValue = false)] public long? errorCount;
        [DataMember(EmitDefaultValue = false)] public long? warningCount;
        [DataMember(EmitDefaultValue = false)] public long? eventsWritten;
        [DataMember(EmitDefaultValue = false)] public long? droppedEvents;
        [DataMember(EmitDefaultValue = false)] public long? droppedDiagnostics;
        [DataMember(EmitDefaultValue = false)] public long? truncatedMessages;
        [DataMember(EmitDefaultValue = false)] public int? maxEvents;
        [DataMember(EmitDefaultValue = false)] public int? maxMessageChars;
        [DataMember(EmitDefaultValue = false)] public bool? timings;
    }
}
