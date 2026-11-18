using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using EnvDTE;
using EnvDTE80;
using EnvDTE90a;

// Execution context IDs are valid only for one pause and one debugged program.
// Reading a list does not switch the developer's selected thread or frame.
internal static partial class Program {
    static long DebugObjectIdentity(object value){return value==null?0:ComIdentity(value);}
    static string ProgramIdentity(EnvDTE.Program program) {
        if(program==null)throw Error("DEBUG_PROGRAM_UNAVAILABLE","No current debugged program is available.");
        var process=program.Process as Process2;
        if(process==null||process.Transport==null)throw Error("DEBUG_PROGRAM_IDENTITY_UNAVAILABLE","The debugger does not expose a stable process transport identity.");
        return Json.Serialize(new object[]{process.ProcessID,process.Name,process.Transport.ID,process.TransportQualifier,program.Name});
    }
    static string ProgramIdentityKey(Session session) {
        var program=session.Dte.Debugger.CurrentProgram;string key=ProgramIdentity(program);int matches=0;
        // Remote phone debugging returns new Program/Process COM proxies on
        // repeated reads. Use observable debugger identity, and fail closed when
        // multiple programs in the process cannot be distinguished by it.
        foreach(EnvDTE.Program candidate in program.Process.Programs)if(ProgramIdentity(candidate)==key)matches++;
        if(matches!=1)throw Error("DEBUG_PROGRAM_IDENTITY_AMBIGUOUS","The current program cannot be uniquely identified within its process.");
        return key;
    }
    sealed class DebugThreadRecord {
        public readonly string Id=Guid.NewGuid().ToString();
        public readonly EnvDTE.Thread Value;public readonly long Identity;
        public DebugThreadRecord(EnvDTE.Thread value){Value=value;Identity=ComIdentity(value);}
    }
    sealed class DebugFrameRecord {
        public readonly string Id=Guid.NewGuid().ToString();
        public readonly EnvDTE.StackFrame Value;public readonly long Identity,ThreadIdentity;
        public DebugFrameRecord(EnvDTE.StackFrame value,long threadIdentity){Value=value;Identity=ComIdentity(value);ThreadIdentity=threadIdentity;}
    }
    sealed partial class Session {
        public string PauseId;
        string PauseProgramIdentity;
        public string ObservedProgramIdentity { get { return PauseProgramIdentity; } }
        public readonly Dictionary<string,DebugThreadRecord> DebugThreads=new Dictionary<string,DebugThreadRecord>();
        public readonly Dictionary<string,DebugFrameRecord> DebugFrames=new Dictionary<string,DebugFrameRecord>();
        partial void OnInvalidatePause();
        public void InvalidatePause(){OnInvalidatePause();PauseId=null;PauseProgramIdentity=null;DebugThreads.Clear();DebugFrames.Clear();}
        public void BeginPause(){InvalidatePause();PauseId=Guid.NewGuid().ToString();}
        public void EnsurePause(){
            RequireBreak(this);
            string program=ProgramIdentityKey(this);
            if(PauseId==null)BeginPause();
            if(PauseProgramIdentity!=null&&PauseProgramIdentity!=program)BeginPause();
            PauseProgramIdentity=program;
        }
        public void CheckSnapshot(string pause,long thread,long frame){
            EnsurePause();
            if(PauseId!=pause||DebugObjectIdentity(Dte.Debugger.CurrentThread)!=thread||DebugObjectIdentity(Dte.Debugger.CurrentStackFrame)!=frame)
                throw Error("DEBUG_CONTEXT_CHANGED","The debugger context changed while reading it; inspect again before using any context IDs.");
        }
        public void CheckPause(Dictionary<string,object> request){
            EnsurePause();string expected=Text(request,"pauseId");
            if(expected==null||expected!=PauseId)throw Error("STALE_DEBUG_CONTEXT","The supplied pauseId does not identify the current paused execution. Inspect again.");
        }
        public DebugThreadRecord RememberThread(EnvDTE.Thread thread){
            long identity=ComIdentity(thread);var old=DebugThreads.Values.FirstOrDefault(value=>value.Identity==identity);
            if(old!=null)return old;
            if(DebugThreads.Count>=2048)throw Error("DEBUG_CONTEXT_LIMIT","Thread context limit reached for this pause.");
            var record=new DebugThreadRecord(thread);DebugThreads.Add(record.Id,record);return record;
        }
        public DebugFrameRecord RememberFrame(EnvDTE.StackFrame frame,long threadIdentity){
            long identity=ComIdentity(frame);var old=DebugFrames.Values.FirstOrDefault(value=>value.Identity==identity&&value.ThreadIdentity==threadIdentity);
            if(old!=null)return old;
            if(DebugFrames.Count>=2048)throw Error("DEBUG_CONTEXT_LIMIT","Frame context limit reached for this pause.");
            var record=new DebugFrameRecord(frame,threadIdentity);DebugFrames.Add(record.Id,record);return record;
        }
    }
    static Dictionary<string,object> ThreadInfo(Session session,EnvDTE.Thread thread){
        var record=session.RememberThread(thread);
        return Map("threadId",record.Id,"nativeId",thread.ID,"id",thread.ID,"name",thread.Name,"program",thread.Program.Name,"pauseId",session.PauseId);
    }
    static Dictionary<string,object> FrameInfo(Session session,EnvDTE.StackFrame frame,long threadIdentity){
        var record=session.RememberFrame(frame,threadIdentity);
        string file=null;uint? line=null,depth=null;string sourceUnavailable=null;
        var extended=frame as StackFrame2;
        if(extended==null)sourceUnavailable="The debugger does not expose StackFrame2 for this frame.";
        else {
            try{file=extended.FileName;line=extended.LineNumber;depth=extended.Depth;}
            catch(COMException error){sourceUnavailable=error.Message;}
        }
        return Map("frameId",record.Id,"pauseId",session.PauseId,"function",frame.FunctionName,"language",frame.Language,"module",frame.Module,
            "sourceFile",string.IsNullOrEmpty(file)?null:file,"line",line,"depth",depth,"sourceUnavailable",sourceUnavailable);
    }
    static Dictionary<string,object> DebugStateContext(Session session){
        var debugger=session.Dte.Debugger;int sequence=session.LastDebuggerEventSequence;var mode=debugger.CurrentMode;var processes=new List<object>();
        foreach(EnvDTE.Process process in debugger.DebuggedProcesses){if(processes.Count>=100)break;processes.Add(Map("processId",process.ProcessID,"name",process.Name));}
        object thread=null,frame=null;
        if(mode==dbgDebugMode.dbgBreakMode){
            session.EnsurePause();string pause=session.PauseId;var current=debugger.CurrentThread;var currentFrame=debugger.CurrentStackFrame;
            if(current!=null){thread=ThreadInfo(session,current);if(currentFrame!=null)frame=FrameInfo(session,currentFrame,ComIdentity(current));}
            session.CheckSnapshot(pause,DebugObjectIdentity(current),DebugObjectIdentity(currentFrame));
        } else session.InvalidatePause();
        string reason=debugger.LastBreakReason.ToString();
        if(debugger.CurrentMode!=mode||session.LastDebuggerEventSequence!=sequence)throw Error("DEBUG_CONTEXT_CHANGED","The debugger transitioned while reading state; inspect again.");
        return Map("mode",Mode(mode),"modeValue",(int)mode,"reason",reason,"processes",processes,
            "lastSequence",session.Sequence,"lastDebuggerEventSequence",session.LastDebuggerEventSequence,"pauseId",session.PauseId,"currentThread",thread,"currentFrame",frame);
    }
    static Dictionary<string,object> InspectContext(Session session,Dictionary<string,object> request){
        session.EnsurePause();string expected=Text(request,"pauseId");
        if(expected!=null&&expected!=session.PauseId)throw Error("STALE_DEBUG_CONTEXT","The requested pause is no longer current.");
        string pause=session.PauseId;long selectedThread=DebugObjectIdentity(session.Dte.Debugger.CurrentThread),selectedFrame=DebugObjectIdentity(session.Dte.Debugger.CurrentStackFrame);
        string kind=Text(request,"kind","frames");int limit=Int(request,"limit",50,1,200);var rows=new List<object>();int total=0;
        if(kind=="threads"){
            foreach(EnvDTE.Thread thread in session.Dte.Debugger.CurrentProgram.Threads){total++;if(rows.Count<limit)rows.Add(ThreadInfo(session,thread));}
        }else if(kind=="frames"){
            long thread=ComIdentity(session.Dte.Debugger.CurrentThread);
            foreach(EnvDTE.StackFrame frame in session.Dte.Debugger.CurrentThread.StackFrames){total++;if(rows.Count<limit)rows.Add(FrameInfo(session,frame,thread));}
        }else if(kind=="locals"){
            CheckCurrentFrame(session,request);
            // StackFrame2 permits inspection without implicit property/function evaluation.
            var extended=session.Dte.Debugger.CurrentStackFrame as StackFrame2;
            var locals=extended==null?session.Dte.Debugger.CurrentStackFrame.Locals:extended.get_Locals2(false);
            foreach(EnvDTE.Expression value in locals){total++;if(rows.Count<limit)rows.Add(Expression(value));}
        }else throw Error("INVALID_REQUEST","Unsupported debug inspection kind.");
        var state=DebugStateContext(session);
        session.CheckSnapshot(pause,selectedThread,selectedFrame);
        return Map("kind",kind,"items",rows,"limit",limit,"total",total,"truncated",total>rows.Count,"pauseId",session.PauseId,
            "currentThread",state["currentThread"],"currentFrame",state["currentFrame"]);
    }
    static void CheckCurrentFrame(Session session,Dictionary<string,object> request){
        string expectedPause=Text(request,"pauseId"),expectedFrame=Text(request,"frameId");
        if(expectedPause!=null&&expectedPause!=session.PauseId)throw Error("STALE_DEBUG_CONTEXT","The supplied pause is no longer current.");
        if(expectedFrame!=null){DebugFrameRecord record;if(expectedPause==null||!session.DebugFrames.TryGetValue(expectedFrame,out record)||record.Identity!=ComIdentity(session.Dte.Debugger.CurrentStackFrame)||record.ThreadIdentity!=ComIdentity(session.Dte.Debugger.CurrentThread))throw Error("DEBUG_CONTEXT_CHANGED","The requested frame is no longer selected. Inspect or select a current frame before evaluating.");}
    }
    static object EvaluateInContext(Session session,Dictionary<string,object> request){
        session.EnsurePause();CheckCurrentFrame(session,request);
        string pause=session.PauseId;long thread=DebugObjectIdentity(session.Dte.Debugger.CurrentThread),frame=DebugObjectIdentity(session.Dte.Debugger.CurrentStackFrame);
        var result=(Dictionary<string,object>)Expression(session.Dte.Debugger.GetExpression(Text(request,"expression"),false,Int(request,"expressionTimeoutMs",1000,100,10000)));
        var state=DebugStateContext(session);session.CheckSnapshot(pause,thread,frame);result["pauseId"]=session.PauseId;result["currentFrame"]=state["currentFrame"];return result;
    }
    static object SelectThread(Session session,Dictionary<string,object> request){
        session.CheckPause(request);string id=Text(request,"threadId");DebugThreadRecord record;
        if(id==null||!session.DebugThreads.TryGetValue(id,out record))throw Error("STALE_DEBUG_CONTEXT","Thread ID was not observed during this pause.");
        bool present=false;foreach(EnvDTE.Thread thread in session.Dte.Debugger.CurrentProgram.Threads)if(ComIdentity(thread)==record.Identity){present=true;break;}
        if(!present)throw Error("STALE_DEBUG_CONTEXT","The observed thread is no longer in the current debugged program.");
        session.Dte.Debugger.CurrentThread=record.Value;return DebugStateContext(session);
    }
    static object SelectFrame(Session session,Dictionary<string,object> request){
        session.CheckPause(request);string id=Text(request,"frameId");DebugFrameRecord record;
        if(id==null||!session.DebugFrames.TryGetValue(id,out record)||record.ThreadIdentity!=ComIdentity(session.Dte.Debugger.CurrentThread))throw Error("STALE_DEBUG_CONTEXT","The frame was not observed for the currently selected thread during this pause.");
        session.Dte.Debugger.CurrentStackFrame=record.Value;return DebugStateContext(session);
    }
}
