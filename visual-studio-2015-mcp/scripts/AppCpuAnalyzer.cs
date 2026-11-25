using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using Microsoft.Diagnostics.Symbols;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;

internal static class AppCpuAnalyzer
{
    private sealed class Identity
    {
        public TraceProcess Process;
        public string Package, App, Key, Event;
        public double ObservedMs;
        public object Describe()
        {
            return new { packageFullName = Package, applicationId = App, uniqueProcessKey = Key,
                identityEvent = Event, identityObservedMs = ObservedMs, processId = Process.ProcessID,
                processIndex = (int)Process.ProcessIndex, imageName = Process.ImageFileName,
                startMs = Process.StartTimeRelativeMsec, endMs = Process.EndTimeRelativeMsec };
        }
    }

    private sealed class Symbol
    {
        public string Path;
        public NativeSymbolModule Pdb;
        public bool Matched;
    }

    private static object Analyze(TraceLog log, string package, int pid, int index, int top, string[] pdbPaths)
    {
        var observations = new Dictionary<int, Identity>();
        var conflicting = new HashSet<int>();
        foreach (var item in log.Events.ByEventType<ProcessTraceData>())
        {
            int opcode = (int)item.Opcode;
            if ((opcode != 1 && opcode != 3 && opcode != 4) || String.IsNullOrEmpty(item.PackageFullName)) continue;
            var process = item.Process();
            if (process == null || process.ProcessID != item.ProcessID) continue;
            int processIndex = (int)process.ProcessIndex;
            var identity = new Identity { Process = process, Package = item.PackageFullName, App = item.ApplicationID,
                Key = item.UniqueProcessKey.ToString("X", CultureInfo.InvariantCulture), Event = item.EventName,
                ObservedMs = item.TimeStampRelativeMSec };
            Identity previous;
            if (observations.TryGetValue(processIndex, out previous))
            {
                if (!String.Equals(previous.Package, identity.Package, StringComparison.OrdinalIgnoreCase) || previous.App != identity.App ||
                    (previous.Key != "0" && identity.Key != "0" && previous.Key != identity.Key)) conflicting.Add(processIndex);
                if (previous.Event == "Process/Start" || opcode != 1) continue;
            }
            observations[processIndex] = identity;
        }
        var matches = observations.Where(p => !conflicting.Contains(p.Key) &&
            String.Equals(p.Value.Package, package, StringComparison.OrdinalIgnoreCase) &&
            (pid == 0 || p.Value.Process.ProcessID == pid) && (index < 0 || p.Key == index))
            .OrderBy(p => p.Key).Select(p => p.Value).ToArray();
        if (matches.Length != 1)
            return new { error = new { code = matches.Length == 0 ? "ETL_PROCESS_NOT_FOUND" : "ETL_PROCESS_AMBIGUOUS",
                message = matches.Length == 0 ? "No matching process instance has consistent ETL package evidence." : "Select a processIndex from the ETL candidates.",
                details = new { matchCount = matches.Length, candidates = matches.Take(100).Select(p => p.Describe()).ToArray() } } };

        var selected = matches[0];
        using (var reader = new SymbolReader(Console.Error, "", null))
        {
            var symbols = pdbPaths.Select(file => new Symbol { Path = file, Pdb = reader.OpenNativeSymbolFile(file) }).ToArray();
            if (symbols.Any(s => s.Pdb == null)) throw new InvalidDataException("Each pdbPaths entry must be a readable native PDB.");
            var matching = new Dictionary<TraceModuleFile, Symbol>();
            var moduleEvidence = new List<object>();
            foreach (var module in selected.Process.LoadedModules.Select(m => m.ModuleFile).Distinct())
            {
                if (module.PdbSignature == Guid.Empty) continue;
                var matchingSymbols = symbols.Where(s => s.Pdb.PdbGuid == module.PdbSignature && s.Pdb.PdbAge == module.PdbAge).ToArray();
                if (matchingSymbols.Length == 0) continue;
                foreach (var match in matchingSymbols) match.Matched = true;
                var symbol = matchingSymbols[0];
                matching.Add(module, symbol);
                moduleEvidence.Add(new { module = module.FilePath, pdbPath = symbol.Path, pdbGuid = module.PdbSignature, pdbAge = module.PdbAge });
            }
            var names = new Dictionary<TraceLoadedModule, Dictionary<uint, string>>();
            var hotspots = new Dictionary<string, int>(StringComparer.Ordinal);
            var stacks = new Dictionary<string, int>(StringComparer.Ordinal);
            int total = 0, attributed = 0, withStack = 0, resolved = 0;
            foreach (var sample in log.Events.ByEventType<SampledProfileTraceData>())
            {
                total++;
                if (sample.ProcessID != selected.Process.ProcessID) continue;
                var sampleProcess = sample.Process();
                if (sampleProcess == null || sampleProcess.ProcessIndex != selected.Process.ProcessIndex) continue;
                attributed++;
                var stack = sample.CallStack();
                if (stack != null) withStack++;
                string leaf = Resolve(selected, sample.InstructionPointer, sample.TimeStampRelativeMSec, matching, names);
                if (leaf == null) continue;
                resolved++;
                Increment(hotspots, leaf);
                while (stack != null && stack.CodeAddress.Address != sample.InstructionPointer) stack = stack.Caller;
                if (stack == null) continue;
                var frames = new List<string> { leaf };
                for (stack = stack.Caller; stack != null && frames.Count < 64; stack = stack.Caller)
                {
                    string caller = Resolve(selected, stack.CodeAddress.Address, sample.TimeStampRelativeMSec, matching, names);
                    if (caller == null) break;
                    frames.Add(caller);
                }
                Increment(stacks, String.Join("\u0000", frames));
            }
            return new { process = selected.Describe(), cpuSampleEvents = total, attributedSamples = attributed,
                stackSamples = withStack, missingStackSamples = attributed - withStack,
                stackCoverage = attributed == 0 ? (double?)null : (double)withStack / attributed,
                resolvedNativeSamples = resolved, unresolvedSamples = attributed - resolved, eventsLost = log.EventsLost,
                pdbs = symbols.Select(s => new { path = s.Path, guid = s.Pdb.PdbGuid, age = s.Pdb.PdbAge, matched = s.Matched }).ToArray(),
                matchedModules = moduleEvidence,
                hotspots = Rank(hotspots, top).Select(p => new { function = p.Key, samples = p.Value }).ToArray(),
                nativeStacks = Rank(stacks, top).Select(p => new { framesLeafToRoot = p.Key.Split('\0'), samples = p.Value }).ToArray() };
        }
    }

    private static string Resolve(Identity identity, ulong address, double time, Dictionary<TraceModuleFile, Symbol> matching,
        Dictionary<TraceLoadedModule, Dictionary<uint, string>> names)
    {
        if (matching.Count == 0) return null;
        var loaded = identity.Process.LoadedModules.GetModuleContainingAddress(address, time);
        Symbol symbol;
        if (loaded == null || !matching.TryGetValue(loaded.ModuleFile, out symbol)) return null;
        uint rva = checked((uint)(address - loaded.ImageBase));
        Dictionary<uint, string> cached;
        if (!names.TryGetValue(loaded, out cached)) names.Add(loaded, cached = new Dictionary<uint, string>());
        string name;
        if (cached.TryGetValue(rva, out name)) return name;
        uint start = 0;
        string method = symbol.Pdb.FindNameForRva(rva, ref start);
        name = String.IsNullOrWhiteSpace(method) ? null : loaded.ModuleFile.FilePath + "!" + method;
        cached.Add(rva, name);
        return name;
    }

    private static void Increment(Dictionary<string, int> counts, string key)
    {
        int count;
        counts.TryGetValue(key, out count);
        counts[key] = count + 1;
    }

    private static IEnumerable<KeyValuePair<string, int>> Rank(Dictionary<string, int> counts, int top)
    {
        return counts.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).Take(top);
    }

    public static int Main(string[] args)
    {
        try
        {
            using (var trace = TraceLog.OpenOrConvert(args[0], new TraceLogOptions { ConversionLog = Console.Error }))
            {
                var result = Analyze(trace, args[2], Int32.Parse(args[3], CultureInfo.InvariantCulture),
                    Int32.Parse(args[4], CultureInfo.InvariantCulture), Int32.Parse(args[5], CultureInfo.InvariantCulture), args.Skip(6).ToArray());
                File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(result));
            }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
