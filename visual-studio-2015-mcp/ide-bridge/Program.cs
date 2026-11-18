using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using EnvDTE;
using EnvDTE80;

// One persistent STA owns every RCW and event subscription. stdin is only read
// on a worker; all outgoing JSON is written by this STA through a real message pump.
internal static partial class Program {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8388608, RecursionLimit = 64 };
    static readonly ConcurrentQueue<string> Input = new ConcurrentQueue<string>();
    static readonly Dictionary<string, Session> Sessions = new Dictionary<string, Session>();
    static volatile bool Ended;
    static bool Busy;
    static System.Windows.Forms.Timer Pump;
    static long Deadline;
    static int MaximumEvents = 1000;

    [STAThread] static int Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        MessageFilter filter = new MessageFilter(delegate { return Deadline; });
        IOleMessageFilter previous; CoRegisterMessageFilter(filter, out previous);
        System.Threading.Thread reader = new System.Threading.Thread(delegate() {
            try { string line; while ((line = Console.ReadLine()) != null) { if (line.Length > 8388608) line = "{}"; Input.Enqueue(line); } }
            catch { } finally { Ended = true; }
        }); reader.IsBackground = true; reader.Start();
        Pump = new System.Windows.Forms.Timer(); Pump.Interval = 20;
        Pump.Tick += delegate {
            if (Busy) return;
            string line;
            if (Input.TryDequeue(out line)) {
                Busy = true; object id = null;
                try {
                    var request = Json.Deserialize<Dictionary<string, object>>(line);
                    if (request == null) throw Error("INVALID_REQUEST", "Expected an object.");
                    request.TryGetValue("id", out id);
                    Deadline = Stopwatch.GetTimestamp() + (long)(Math.Min(30000, Int(request,"comTimeoutMs",10000,100,30000)) * (double)Stopwatch.Frequency / 1000);
                    object result = Dispatch(request);
                    Write(Map("id",id,"result",result));
                } catch (Exception error) {
                    Exception cause = error;
                    while (cause is System.Reflection.TargetInvocationException && cause.InnerException != null) cause = cause.InnerException;
                    string code = cause.Data.Contains("code") ? (string)cause.Data["code"] : cause is COMException ? "IDE_COM_ERROR" : "IDE_ERROR";
                    if(cause is COMException && new[]{unchecked((int)0x800706BA),unchecked((int)0x80010108),unchecked((int)0x800401FD),unchecked((int)0x80010007),unchecked((int)0x80010012)}.Contains(cause.HResult))code="IDE_DISCONNECTED";
                    Write(Map("id",id,"error",Map("code",code,"message",cause.Message,"hresult",cause.HResult)));
                } finally { Deadline = 0; Busy = false; }
            } else if (Ended) {
                foreach (var session in Sessions.Values.ToArray()) session.Dispose();
                Sessions.Clear(); Pump.Stop(); Application.ExitThread();
            }
        };
        Pump.Start(); Application.Run(); IOleMessageFilter ignored; CoRegisterMessageFilter(previous,out ignored); return 0;
    }
    static void Write(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static Dictionary<string,object> Map(params object[] pairs) { var map = new Dictionary<string,object>(); for (int i=0;i<pairs.Length;i+=2) map[(string)pairs[i]]=pairs[i+1]; return map; }
    static Exception Error(string code,string message) { var e = new InvalidOperationException(message); e.Data["code"]=code; return e; }
    static string Text(Dictionary<string,object> r,string key,string fallback=null) { object value; if(!r.TryGetValue(key,out value)||value==null)return fallback; var s=value as string; if(s==null||s.IndexOf('\0')>=0)throw Error("INVALID_REQUEST",key+" must be text without NUL."); return s; }
    static int Int(Dictionary<string,object> r,string key,int fallback,int min,int max) { object value; if(!r.TryGetValue(key,out value))return fallback; double n=Convert.ToDouble(value); if(double.IsNaN(n)||double.IsInfinity(n)||n<min||n>max||n!=Math.Floor(n))throw Error("INVALID_REQUEST",key+" is out of range.");return(int)n; }
    static bool Bool(Dictionary<string,object> r,string key,bool fallback=false) { object value; if(!r.TryGetValue(key,out value))return fallback;if(!(value is bool))throw Error("INVALID_REQUEST",key+" must be boolean.");return(bool)value; }
    static string Limit(string value,int max) { value=value??"";return value.Length>max?value.Substring(0,max):value; }
    static object Dispatch(Dictionary<string,object> r) {
        string operation=Text(r,"operation");
        if(operation=="instances") return Map("instances",Instances());
        if(operation=="attach") return Attach(r);
        string sid=Text(r,"sessionId");Session s;
        if(sid==null||!Sessions.TryGetValue(sid,out s))throw Error("SESSION_NOT_FOUND","Attach to a running VS2015 instance first.");
        // Releasing automation resources must remain possible after the IDE exits.
        if(operation=="detach"){s.Dispose();Sessions.Remove(sid);return Map("detached",true,"processId",s.ProcessId,"ideClosed",false,"cleanupWarnings",s.CleanupWarnings);}
        s.CheckIdentity();
        switch(operation) {
            case "solutionStatus": return SolutionStatus(s);
            case "openSolution": RequireDesign(s);if(s.Dte.Solution.IsOpen)throw Error("SOLUTION_ALREADY_OPEN","Close or choose another IDE before opening a different solution."); string solution=Path.GetFullPath(Text(r,"path"));if(!File.Exists(solution))throw Error("FILE_NOT_FOUND",solution);s.Dte.Solution.Open(solution);return SolutionStatus(s);
            case "buildActive": return StartBuild(s,r);
            case "buildStatus": return BuildStatus(s,r);
            case "buildReconcile": return ReconcileBuild(s,r);
            case "events": int after=Int(r,"afterSequence",0,0,int.MaxValue), count=Int(r,"limit",100,1,500);return Map("events",s.Events.Where(e=>Convert.ToInt32(e["sequence"])>after).Take(count).ToArray(),"lastSequence",s.Sequence,"oldestSequence",s.Events.Count>0?s.Events[0]["sequence"]:(object)null);
            case "debugState": return DebugState(s);
            case "breakpoints": return Breakpoints(s,r);
            case "debugControl": return DebugControl(s,r);
            case "debugInspect": return DebugInspect(s,r);
            case "evaluate": RequireBreak(s);return Expression(s.Dte.Debugger.GetExpression(Text(r,"expression"),false,Int(r,"expressionTimeoutMs",1000,100,10000)));
            case "documents": return Documents(s);
            case "openDocument": return OpenDocument(s,r);
            case "readDocument": return ReadDocument(s,r);
            case "editDocument": return EditDocument(s,r);
            case "saveDocument": Document document=FindDocument(s,Text(r,"path"));document.Save("");return DocumentInfo(document);
            case "errorsOutput": return ErrorsOutput(s,r);
            default: throw Error("UNKNOWN_OPERATION","Unsupported IDE operation.");
        }
    }
    static void RequireDesign(Session s) { if(s.Dte.Debugger.CurrentMode!=dbgDebugMode.dbgDesignMode)throw Error("DEBUGGER_BUSY","This operation requires design mode."); }
    static void RequireBreak(Session s) { if(s.Dte.Debugger.CurrentMode!=dbgDebugMode.dbgBreakMode)throw Error("NOT_IN_BREAK_MODE","Pause at a breakpoint before inspecting execution state."); }

    [DllImport("ole32.dll")] static extern int GetRunningObjectTable(int reserved,out IRunningObjectTable table);
    [DllImport("ole32.dll")] static extern int CreateBindCtx(int reserved,out IBindCtx context);
    [DllImport("ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter filter,out IOleMessageFilter previous);
    static List<Dictionary<string,object>> Instances() {
        var rows=new List<Dictionary<string,object>>(); IRunningObjectTable table=null;IBindCtx context=null;IEnumMoniker iterator=null;
        try {
            Marshal.ThrowExceptionForHR(GetRunningObjectTable(0,out table));Marshal.ThrowExceptionForHR(CreateBindCtx(0,out context));table.EnumRunning(out iterator);
            IMoniker[] slot=new IMoniker[1];
            while(iterator.Next(1,slot,IntPtr.Zero)==0) {
                try {
                    string name;slot[0].GetDisplayName(context,null,out name);
                    const string prefix="!VisualStudio.DTE.14.0:";
                    if(!name.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))continue;
                    int pid;if(!int.TryParse(name.Substring(prefix.Length),out pid))continue;
                    using(var p=System.Diagnostics.Process.GetProcessById(pid)) {
                        string version=null,exe=null;try{exe=p.MainModule.FileName;version=FileVersionInfo.GetVersionInfo(exe).FileVersion;}catch{}
                        rows.Add(Map("processId",pid,"startTimeUtc",p.StartTime.ToUniversalTime().ToString("o"),"moniker",name,"executable",exe,"fileVersion",version));
                    }
                } catch(COMException) { } catch(ArgumentException) { } catch(InvalidOperationException) { } catch(System.ComponentModel.Win32Exception) { }
                finally { if(slot[0]!=null)Marshal.ReleaseComObject(slot[0]);slot[0]=null; }
            }
        } finally { if(iterator!=null)Marshal.ReleaseComObject(iterator);if(context!=null)Marshal.ReleaseComObject(context);if(table!=null)Marshal.ReleaseComObject(table); }
        return rows;
    }
    static object Attach(Dictionary<string,object> r) {
        int pid=Int(r,"processId",0,1,int.MaxValue);string expected=Text(r,"expectedStartTimeUtc");
        if(expected==null)throw Error("IDENTITY_REQUIRED","expectedStartTimeUtc is required; obtain it from instances.");
        DateTime wanted;if(!DateTime.TryParse(expected,null,System.Globalization.DateTimeStyles.RoundtripKind,out wanted))throw Error("INVALID_REQUEST","Invalid expectedStartTimeUtc.");
        using(var p=System.Diagnostics.Process.GetProcessById(pid)) {
            DateTime start=p.StartTime.ToUniversalTime();
            // Node ISO timestamps preserve milliseconds rather than .NET ticks.
            if(Math.Abs((start-wanted.ToUniversalTime()).TotalMilliseconds)>=1)throw Error("TARGET_CHANGED","PID start time differs from the selected instance.");
            var old=Sessions.Values.FirstOrDefault(x=>x.ProcessId==pid&&x.StartTicks==start.Ticks);if(old!=null)return old.Info();
            object value=GetRotObject(pid);var dte=value as DTE2;
            if(dte==null)throw Error("DTE_UNAVAILABLE","The selected VS2015 ROT object is not available.");
            if(!dte.Version.StartsWith("14.",StringComparison.Ordinal)){Marshal.ReleaseComObject(dte);throw Error("VERSION_MISMATCH","Expected VS2015 DTE 14.x.");}
            Mutex lease=new Mutex(false,"Local\\VS2015Mcp_IDE_"+pid+"_"+start.Ticks);bool owned=false;
            try {
                try {owned=lease.WaitOne(0);}catch(AbandonedMutexException){owned=true;}
                if(!owned)throw Error("SESSION_BUSY","Another MCP bridge has an automation lease for this IDE instance.");
                using(var current=System.Diagnostics.Process.GetProcessById(pid)){if(current.StartTime.ToUniversalTime()!=start)throw Error("TARGET_CHANGED","The selected IDE changed while connecting.");}
                var session=new Session(pid,start,dte,lease);Sessions.Add(session.Id,session);return session.Info();
            } catch {if(owned)lease.ReleaseMutex();lease.Dispose();Marshal.ReleaseComObject(dte);throw;}
        }
    }
    static object GetRotObject(int pid) {
        IRunningObjectTable table=null;IBindCtx context=null;IEnumMoniker iterator=null;
        try {
            Marshal.ThrowExceptionForHR(GetRunningObjectTable(0,out table));Marshal.ThrowExceptionForHR(CreateBindCtx(0,out context));table.EnumRunning(out iterator);IMoniker[] slot=new IMoniker[1];
            while(iterator.Next(1,slot,IntPtr.Zero)==0) {
                try { string name;slot[0].GetDisplayName(context,null,out name);if(string.Equals(name,"!VisualStudio.DTE.14.0:"+pid,StringComparison.OrdinalIgnoreCase)){object value;table.GetObject(slot[0],out value);return value;} }
                catch(COMException){}finally{if(slot[0]!=null)Marshal.ReleaseComObject(slot[0]);slot[0]=null;}
            }
            throw Error("DTE_UNAVAILABLE","The selected VS2015 instance is not registered in the ROT for this user/integrity level.");
        } finally {if(iterator!=null)Marshal.ReleaseComObject(iterator);if(context!=null)Marshal.ReleaseComObject(context);if(table!=null)Marshal.ReleaseComObject(table);}
    }
    static object SolutionStatus(Session s) {
        var solution=s.Dte.Solution;var projects=new List<object>();
        foreach(Project project in solution.Projects) {if(projects.Count>=500)break;try{projects.Add(Map("name",project.Name,"uniqueName",project.UniqueName,"kind",project.Kind,"fileName",project.FullName));}catch(COMException){}}
        string configuration=null,platform=null;try{var active=(SolutionConfiguration2)solution.SolutionBuild.ActiveConfiguration;configuration=active.Name;platform=active.PlatformName;}catch(COMException){}
        return Map("sessionId",s.Id,"isOpen",solution.IsOpen,"fullName",solution.FullName,"saved",solution.Saved,"activeConfiguration",configuration,"activePlatform",platform,"startupProjects",solution.SolutionBuild.StartupProjects,"projects",projects,"buildState",solution.SolutionBuild.BuildState.ToString(),"debugger",DebugState(s));
    }
    static object StartBuild(Session s,Dictionary<string,object> r) {
        RequireDesign(s);if(!s.Dte.Solution.IsOpen)throw Error("NO_SOLUTION","No solution is open.");
        if(s.ActiveBuild!=null||s.Dte.Solution.SolutionBuild.BuildState==vsBuildState.vsBuildStateInProgress)throw Error("BUILD_BUSY","An IDE build is already in progress.");
        string action=Text(r,"action","build");if(!new[]{"build","rebuild","clean","deploy"}.Contains(action))throw Error("INVALID_REQUEST","Unsupported build action.");
        var job=new BuildJob{Id=Guid.NewGuid().ToString(),Action=action,State="started",StartedUtc=DateTime.UtcNow.ToString("o"),Phase=action};
        s.TrackBuild(job);s.ActiveBuild=job;
        // SolutionBuild has no Rebuild method. Invoke only this fixed standard
        // IDE command; completion still comes from the RebuildAll events.
        try{if(action=="rebuild")s.Dte.ExecuteCommand("Build.RebuildSolution","");else if(action=="clean")s.Dte.Solution.SolutionBuild.Clean(false);else if(action=="deploy")s.Dte.Solution.SolutionBuild.Deploy(false);else s.Dte.Solution.SolutionBuild.Build(false);}
        catch{job.State="start-failed";job.Complete=false;s.ActiveBuild=null;throw;}
        return job.Info();
    }
    static object BuildStatus(Session s,Dictionary<string,object> r) {BuildJob job=FindBuild(s,r);var info=job.Info();info["ideBuildState"]=s.Dte.Solution.SolutionBuild.BuildState.ToString();info["retentionLimit"]=Session.MaximumBuilds;info["evictedBuilds"]=s.EvictedBuilds;return info;}
    static BuildJob FindBuild(Session s,Dictionary<string,object> r) {string id=Text(r,"buildId");BuildJob job;if(id==null||!s.Builds.TryGetValue(id,out job))throw Error("BUILD_NOT_FOUND","Unknown or evicted build ID for this session.");return job;}
    static object ReconcileBuild(Session s,Dictionary<string,object> r) {
        BuildJob job=FindBuild(s,r);var actual=s.Dte.Solution.SolutionBuild.BuildState;
        if(actual==vsBuildState.vsBuildStateInProgress)throw Error("BUILD_BUSY","The IDE reports a build in progress; reconciliation will not stop or unlock it.");
        bool reconciled=false;
        if(object.ReferenceEquals(s.ActiveBuild,job)){
            job.State="unconfirmed";job.Complete=false;job.LastBuildInfo=null;job.FinishedUtc=DateTime.UtcNow.ToString("o");s.ActiveBuild=null;reconciled=true;
            s.Event("buildReconciled",Map("buildId",job.Id,"ideBuildState",actual.ToString(),"outcomeKnown",false));
        }
        var info=job.Info();info["reconciled"]=reconciled;info["ideBuildState"]=actual.ToString();info["outcomeKnown"]=job.Complete;return info;
    }
    static string Mode(dbgDebugMode mode) {return mode==dbgDebugMode.dbgBreakMode?"break":mode==dbgDebugMode.dbgRunMode?"run":"design";}
    static object DebugState(Session s) {var debugger=s.Dte.Debugger;var processes=new List<object>();foreach(EnvDTE.Process process in debugger.DebuggedProcesses){if(processes.Count>=100)break;processes.Add(Map("processId",process.ProcessID,"name",process.Name));}return Map("mode",Mode(debugger.CurrentMode),"modeValue",(int)debugger.CurrentMode,"reason",debugger.LastBreakReason.ToString(),"processes",processes,"lastSequence",s.Sequence,"lastDebuggerEventSequence",s.LastDebuggerEventSequence);}
    static object Breakpoints(Session s,Dictionary<string,object> r) {
        string action=Text(r,"action","list");
        if(action=="add") {
            RequireDesignOrBreak(s);string file=Text(r,"file"),function=Text(r,"function");if(string.IsNullOrWhiteSpace(file)==string.IsNullOrWhiteSpace(function))throw Error("INVALID_REQUEST","Specify exactly one file or function.");
            var before=new HashSet<long>();foreach(Breakpoint existing in s.Dte.Debugger.Breakpoints)before.Add(ComIdentity(existing));
            var added=s.Dte.Debugger.Breakpoints.Add(function??"",file==null?"":Path.GetFullPath(file),Int(r,"line",1,1,int.MaxValue),1,"",dbgBreakpointConditionType.dbgBreakpointConditionTypeWhenTrue,"","",0,"",0,dbgHitCountType.dbgHitCountTypeNone);
            foreach(Breakpoint bp in added)s.RememberBreakpoint(bp,!before.Contains(ComIdentity(bp)));
        } else if(action=="delete") {
            string id=Text(r,"breakpointId");BreakpointRecord record;if(id==null||!s.Breakpoints.TryGetValue(id,out record))throw Error("BREAKPOINT_NOT_FOUND","Delete requires an ID observed in this session.");
            if(!record.Owned)throw Error("BREAKPOINT_NOT_OWNED","This breakpoint was observed, not created by this automation session.");
            s.DeleteOwnedBreakpoint(record);s.Breakpoints.Remove(id);
        } else if(action!="list")throw Error("INVALID_REQUEST","Unsupported breakpoint action.");
        var rows=new List<object>();foreach(Breakpoint bp in s.Dte.Debugger.Breakpoints){if(rows.Count>=500)break;BreakpointRecord record=s.RememberBreakpoint(bp,false);rows.Add(Map("breakpointId",record.Id,"owned",record.Owned,"file",bp.File,"line",bp.FileLine,"function",bp.FunctionName,"enabled",bp.Enabled,"type",bp.Type.ToString()));}return Map("breakpoints",rows);
    }
    static long ComIdentity(object value){IntPtr pointer=Marshal.GetIUnknownForObject(value);try{return pointer.ToInt64();}finally{Marshal.Release(pointer);}}
    static void RequireDesignOrBreak(Session s){if(s.Dte.Debugger.CurrentMode==dbgDebugMode.dbgRunMode)throw Error("DEBUGGER_RUNNING","Pause execution before changing breakpoints.");}
    static object DebugControl(Session s,Dictionary<string,object> r) {
        string action=Text(r,"action");var debugger=s.Dte.Debugger;var mode=debugger.CurrentMode;int afterSequence=s.LastDebuggerEventSequence;
        switch(action) {
            case "go": if(mode==dbgDebugMode.dbgRunMode)throw Error("INVALID_DEBUG_STATE","Debugger is already running.");debugger.Go(false);break;
            case "break": if(mode!=dbgDebugMode.dbgRunMode)throw Error("INVALID_DEBUG_STATE","Debugger must be running.");debugger.Break(false);break;
            case "stepInto":RequireBreak(s);debugger.StepInto(false);break;
            case "stepOver":RequireBreak(s);debugger.StepOver(false);break;
            case "stepOut":RequireBreak(s);debugger.StepOut(false);break;
            case "stop":if(mode==dbgDebugMode.dbgDesignMode)throw Error("INVALID_DEBUG_STATE","No debug session is active.");debugger.Stop(false);break;
            default:throw Error("INVALID_REQUEST","Unsupported debug action.");
        }
        return Map("issued",true,"action",action,"afterSequence",afterSequence,"note","Query debugState or wait for events to confirm the resulting mode.");
    }
    static object DebugInspect(Session s,Dictionary<string,object> r) {
        RequireBreak(s);string kind=Text(r,"kind","frames");int limit=Int(r,"limit",50,1,200);var rows=new List<object>();
        if(kind=="threads") {foreach(EnvDTE.Thread t in s.Dte.Debugger.CurrentProgram.Threads){if(rows.Count>=limit)break;rows.Add(Map("id",t.ID,"name",t.Name,"program",t.Program.Name));}}
        else if(kind=="frames") {foreach(EnvDTE.StackFrame frame in s.Dte.Debugger.CurrentThread.StackFrames){if(rows.Count>=limit)break;rows.Add(Map("function",frame.FunctionName,"language",frame.Language,"module",frame.Module));}}
        else if(kind=="locals") {foreach(EnvDTE.Expression expression in s.Dte.Debugger.CurrentStackFrame.Locals){if(rows.Count>=limit)break;rows.Add(Expression(expression));}}
        else throw Error("INVALID_REQUEST","Unsupported debug inspection kind.");
        return Map("kind",kind,"items",rows,"limit",limit);
    }
    static object Expression(EnvDTE.Expression value){return Map("name",value.Name,"type",value.Type,"value",Limit(value.Value,16384),"isValidValue",value.IsValidValue,"valueTruncated",(value.Value??"").Length>16384);}
    static string ReadText(TextDocument text){return text.EndPoint.AtStartOfDocument ? "" : text.StartPoint.CreateEditPoint().GetText(text.EndPoint);}
    static Document FindDocument(Session s,string path){if(path==null)throw Error("INVALID_REQUEST","path is required.");string full=Path.GetFullPath(path);foreach(Document d in s.Dte.Documents){if(string.Equals(d.FullName,full,StringComparison.OrdinalIgnoreCase))return d;}throw Error("DOCUMENT_NOT_OPEN","Open this document in the selected IDE first.");}
    static object DocumentInfo(Document d){return Map("path",d.FullName,"name",d.Name,"saved",d.Saved,"readOnly",d.ReadOnly,"kind",d.Kind,"language",d.Language);}
    static object Documents(Session s){var docs=new List<object>();foreach(Document d in s.Dte.Documents){if(docs.Count>=200)break;docs.Add(DocumentInfo(d));}var active=s.Dte.ActiveDocument;return Map("documents",docs,"activeDocument",active==null?null:DocumentInfo(active));}
    static object OpenDocument(Session s,Dictionary<string,object> r){string path=Path.GetFullPath(Text(r,"path"));if(!File.Exists(path))throw Error("FILE_NOT_FOUND",path);s.Dte.ItemOperations.OpenFile(path,Constants.vsViewKindTextView);Document document=FindDocument(s,path);var text=document.Object("TextDocument") as TextDocument;if(text!=null){int line=Int(r,"line",1,1,text.EndPoint.Line);int column=Int(r,"column",1,1,1000000);var selection=(TextSelection)document.Selection;selection.MoveToLineAndOffset(line,column,false);}return DocumentInfo(document);}
    static object ReadDocument(Session s,Dictionary<string,object> r){Document d=FindDocument(s,Text(r,"path"));TextDocument text=d.Object("TextDocument") as TextDocument;if(text==null)throw Error("NOT_TEXT_DOCUMENT","Document has no text buffer.");int max=Int(r,"maxChars",64000,1,1048576);string content=ReadText(text);return Map("path",d.FullName,"text",Limit(content,max),"truncated",content.Length>max,"length",content.Length,"saved",d.Saved);}
    static object EditDocument(Session s,Dictionary<string,object> r){RequireDesign(s);Document d=FindDocument(s,Text(r,"path"));if(d.ReadOnly)throw Error("READ_ONLY_DOCUMENT","Document is read-only.");TextDocument text=d.Object("TextDocument") as TextDocument;if(text==null)throw Error("NOT_TEXT_DOCUMENT","Document has no text buffer.");string old=ReadText(text),expected=Text(r,"expectedText"),replacement=Text(r,"text");if(expected==null||replacement==null)throw Error("INVALID_REQUEST","Expected and replacement text are required.");if(old!=expected)throw Error("DOCUMENT_CONFLICT","The IDE buffer differs from expectedText; re-read it before editing.");if(replacement.Length>1048576)throw Error("INVALID_REQUEST","Replacement text exceeds one million characters.");text.StartPoint.CreateEditPoint().ReplaceText(text.EndPoint,replacement,(int)vsEPReplaceTextOptions.vsEPReplaceTextKeepMarkers);if(Bool(r,"save"))d.Save("");return DocumentInfo(d);}
    static object ErrorsOutput(Session s,Dictionary<string,object> r) {
        string kind=Text(r,"kind","errors");int offset=Int(r,"offset",0,0,int.MaxValue),limit=Int(r,"limit",100,1,500);
        if(kind=="errors"){var source=s.Dte.ToolWindows.ErrorList.ErrorItems;var rows=new List<object>();for(int i=offset+1;i<=source.Count&&rows.Count<limit;i++){ErrorItem e=source.Item(i);rows.Add(Map("severity",e.ErrorLevel.ToString(),"message",Limit(e.Description,16384),"file",e.FileName,"line",e.Line,"column",e.Column,"project",e.Project));}return Map("items",rows,"total",source.Count,"offset",offset,"limit",limit,"source","IDE Error List");}
        if(kind=="output"){string requested=Text(r,"paneGuid");var panes=s.Dte.ToolWindows.OutputWindow.OutputWindowPanes;var inventory=new List<object>();OutputWindowPane chosen=null;foreach(OutputWindowPane pane in panes){inventory.Add(Map("name",pane.Name,"guid",pane.Guid));if(requested!=null&&string.Equals(requested,pane.Guid,StringComparison.OrdinalIgnoreCase))chosen=pane;}if(requested==null)return Map("panes",inventory);if(chosen==null)throw Error("PANE_NOT_FOUND","Choose an actual pane GUID from the pane inventory.");TextDocument text=chosen.TextDocument;string content=ReadText(text);int max=Int(r,"maxChars",64000,1,1048576);return Map("guid",chosen.Guid,"name",chosen.Name,"text",Limit(content,max),"truncated",content.Length>max);}
        throw Error("INVALID_REQUEST","kind must be errors or output.");
    }

    sealed class BuildJob {
        public string Id,Action,Phase,State,StartedUtc,FinishedUtc;public bool Complete;public int? LastBuildInfo;public bool SawBegin;
        public Dictionary<string,object> Info(){return Map("buildId",Id,"action",Action,"phase",Phase,"state",State,"complete",Complete,"terminal",State!="started","startedAtUtc",StartedUtc,"finishedAtUtc",FinishedUtc,"lastBuildInfo",LastBuildInfo,"beginEventObserved",SawBegin);}
    }
    sealed class BreakpointRecord {
        public readonly string Id=Guid.NewGuid().ToString();public readonly Breakpoint Value;public readonly long Identity;public readonly bool Owned;public string OwnershipTag;
        public BreakpointRecord(Breakpoint value,bool owned){Value=value;Identity=ComIdentity(value);Owned=owned;}
    }
    sealed class Session : IDisposable {
        public readonly string Id=Guid.NewGuid().ToString();public readonly int ProcessId;public readonly long StartTicks;public readonly string StartUtc;public DTE2 Dte;
        public int Sequence,LastDebuggerEventSequence;public readonly List<Dictionary<string,object>> Events=new List<Dictionary<string,object>>();public readonly Dictionary<string,BuildJob> Builds=new Dictionary<string,BuildJob>();public BuildJob ActiveBuild;
        public readonly Dictionary<string,BreakpointRecord> Breakpoints=new Dictionary<string,BreakpointRecord>();
        public const int MaximumBuilds=64;public int EvictedBuilds;
        readonly Queue<string> BuildOrder=new Queue<string>();
        BuildEvents BuildEvents;DebuggerEvents DebuggerEvents;Mutex Lease;bool Disposed;
        public readonly List<string> CleanupWarnings=new List<string>();
        public Session(int pid,DateTime start,DTE2 dte,Mutex lease){
            ProcessId=pid;StartTicks=start.Ticks;StartUtc=start.ToString("o");Dte=dte;
            try {BuildEvents=dte.Events.BuildEvents;DebuggerEvents=dte.Events.DebuggerEvents;BuildEvents.OnBuildBegin+=BeginBuild;BuildEvents.OnBuildDone+=DoneBuild;DebuggerEvents.OnEnterBreakMode+=EnterBreak;DebuggerEvents.OnEnterRunMode+=EnterRun;DebuggerEvents.OnEnterDesignMode+=EnterDesign;Event("attached",Map("processId",pid));Lease=lease;}
            catch {Unsubscribe();Dte=null;throw;} // Attach still owns DTE and lease until construction succeeds.
        }
        public object Info(){return Map("sessionId",Id,"processId",ProcessId,"startTimeUtc",StartUtc,"version",Dte.Version);}
        public void CheckIdentity(){try{using(var p=System.Diagnostics.Process.GetProcessById(ProcessId)){if(p.StartTime.ToUniversalTime().Ticks!=StartTicks)throw Error("TARGET_CHANGED","The selected IDE PID has been reused.");}}catch(ArgumentException){throw Error("IDE_CLOSED","The selected IDE is no longer running.");}}
        public void Event(string kind,Dictionary<string,object> data){data["kind"]=kind;data["sequence"]=++Sequence;data["timestampUtc"]=DateTime.UtcNow.ToString("o");Events.Add(data);if(Events.Count>MaximumEvents)Events.RemoveAt(0);}
        public void TrackBuild(BuildJob job){
            while(BuildOrder.Count>=MaximumBuilds){string oldest=BuildOrder.Dequeue();if(ActiveBuild!=null&&oldest==ActiveBuild.Id)throw Error("BUILD_BUSY","Cannot evict an active build.");Builds.Remove(oldest);EvictedBuilds++;}
            Builds.Add(job.Id,job);BuildOrder.Enqueue(job.Id);
        }
        public BreakpointRecord RememberBreakpoint(Breakpoint bp,bool own){
            long identity=ComIdentity(bp);foreach(var item in Breakpoints.Values)if(item.Identity==identity)return item;
            var record=new BreakpointRecord(bp,own);
            if(own){string tag="VS2015MCP:"+Id+":"+record.Id;try{bp.Tag=tag;record.OwnershipTag=tag;}catch(COMException){}}
            Breakpoints.Add(record.Id,record);return record;
        }
        public void DeleteOwnedBreakpoint(BreakpointRecord record){
            if(!record.Owned)throw Error("BREAKPOINT_NOT_OWNED","The automation session does not own this breakpoint.");
            if(record.OwnershipTag!=null&&record.Value.Tag!=record.OwnershipTag)throw Error("BREAKPOINT_OWNERSHIP_CHANGED","The breakpoint ownership tag changed; it will be preserved.");
            record.Value.Delete();
        }
        bool MatchesBuild(vsBuildScope scope,vsBuildAction action){if(ActiveBuild==null||scope!=vsBuildScope.vsBuildScopeSolution)return false;return (ActiveBuild.Phase=="rebuild"&&action==vsBuildAction.vsBuildActionRebuildAll)||(ActiveBuild.Phase=="clean"&&action==vsBuildAction.vsBuildActionClean)||(ActiveBuild.Phase=="build"&&action==vsBuildAction.vsBuildActionBuild)||(ActiveBuild.Phase=="deploy"&&action==vsBuildAction.vsBuildActionDeploy);}
        void BeginBuild(vsBuildScope scope,vsBuildAction action){if(MatchesBuild(scope,action))ActiveBuild.SawBegin=true;Event("buildBegin",Map("scope",scope.ToString(),"action",action.ToString(),"buildId",ActiveBuild==null?null:ActiveBuild.Id));}
        void DoneBuild(vsBuildScope scope,vsBuildAction action){
            try { DoneBuildCore(scope,action); }
            catch(Exception error){if(ActiveBuild!=null){ActiveBuild.State="unconfirmed";ActiveBuild.Complete=false;ActiveBuild.FinishedUtc=DateTime.UtcNow.ToString("o");Event("buildUnconfirmed",Map("buildId",ActiveBuild.Id,"message",error.Message));ActiveBuild=null;}}
        }
        void DoneBuildCore(vsBuildScope scope,vsBuildAction action){
            BuildJob job=ActiveBuild;Event("buildDone",Map("scope",scope.ToString(),"action",action.ToString(),"buildId",job==null?null:job.Id));if(job==null)return;
            if(!job.SawBegin||!MatchesBuild(scope,action)){job.State="unconfirmed";job.Complete=false;ActiveBuild=null;return;}
            int info=Dte.Solution.SolutionBuild.LastBuildInfo;job.LastBuildInfo=info;
            job.Complete=true;job.State=info==0?"succeeded":"failed";job.FinishedUtc=DateTime.UtcNow.ToString("o");ActiveBuild=null;
        }
        void EnterBreak(dbgEventReason reason,ref dbgExecutionAction action){Event("debugBreak",Map("reason",reason.ToString()));LastDebuggerEventSequence=Sequence;}
        void EnterRun(dbgEventReason reason){Event("debugRun",Map("reason",reason.ToString()));LastDebuggerEventSequence=Sequence;}
        void EnterDesign(dbgEventReason reason){Event("debugDesign",Map("reason",reason.ToString()));LastDebuggerEventSequence=Sequence;}
        void Cleanup(Action action){try{action();}catch(Exception error){CleanupWarnings.Add(error.Message);}}
        void Unsubscribe(){
            if(BuildEvents!=null){Cleanup(delegate{BuildEvents.OnBuildBegin-=BeginBuild;});Cleanup(delegate{BuildEvents.OnBuildDone-=DoneBuild;});Cleanup(delegate{Marshal.ReleaseComObject(BuildEvents);});BuildEvents=null;}
            if(DebuggerEvents!=null){Cleanup(delegate{DebuggerEvents.OnEnterBreakMode-=EnterBreak;});Cleanup(delegate{DebuggerEvents.OnEnterRunMode-=EnterRun;});Cleanup(delegate{DebuggerEvents.OnEnterDesignMode-=EnterDesign;});Cleanup(delegate{Marshal.ReleaseComObject(DebuggerEvents);});DebuggerEvents=null;}
        }
        public void Dispose(){
            if(Disposed)return;Disposed=true;
            try {
                foreach(var record in Breakpoints.Values.Where(x=>x.Owned).ToArray())Cleanup(delegate{DeleteOwnedBreakpoint(record);});
                Unsubscribe();Breakpoints.Clear();if(Dte!=null){Cleanup(delegate{Marshal.ReleaseComObject(Dte);});Dte=null;}
            } finally {if(Lease!=null){try{Lease.ReleaseMutex();}finally{Lease.Dispose();Lease=null;}}}
        }
    }
    [ComImport,Guid("00000016-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IOleMessageFilter {
        [PreserveSig]int HandleInComingCall(int type,IntPtr task,int tick,IntPtr info);
        [PreserveSig]int RetryRejectedCall(IntPtr task,int tick,int rejectType);
        [PreserveSig]int MessagePending(IntPtr task,int tick,int pendingType);
    }
    sealed class MessageFilter : IOleMessageFilter {
        readonly Func<long> Deadline;public MessageFilter(Func<long> deadline){Deadline=deadline;}
        public int HandleInComingCall(int type,IntPtr task,int tick,IntPtr info){return 0;}
        public int RetryRejectedCall(IntPtr task,int tick,int rejectType){long deadline=Deadline();return (rejectType==1||rejectType==2)&&deadline>0&&Stopwatch.GetTimestamp()<deadline?100:-1;}
        public int MessagePending(IntPtr task,int tick,int pendingType){return 2;}
    }
}
