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
        long PauseProgramIdentity;
        public readonly Dictionary<string,DebugThreadRecord> DebugThreads=new Dictionary<string,DebugThreadRecord>();
        public readonly Dictionary<string,DebugFrameRecord> DebugFrames=new Dictionary<string,DebugFrameRecord>();
        public void InvalidatePause(){PauseId=null;PauseProgramIdentity=0;DebugThreads.Clear();DebugFrames.Clear();}
        public void BeginPause(){InvalidatePause();PauseId=Guid.NewGuid().ToString();}
        public void EnsurePause(){
            RequireBreak(this);
            long program=ComIdentity(Dte.Debugger.CurrentProgram);
            if(PauseId==null)BeginPause();
            if(PauseProgramIdentity!=0&&PauseProgramIdentity!=program)BeginPause();
            PauseProgramIdentity=program;
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
        var debugger=session.Dte.Debugger;var mode=debugger.CurrentMode;var processes=new List<object>();
        foreach(EnvDTE.Process process in debugger.DebuggedProcesses){if(processes.Count>=100)break;processes.Add(Map("processId",process.ProcessID,"name",process.Name));}
        object thread=null,frame=null;
        if(mode==dbgDebugMode.dbgBreakMode){
            session.EnsurePause();var current=debugger.CurrentThread;
            if(current!=null){thread=ThreadInfo(session,current);var currentFrame=debugger.CurrentStackFrame;if(currentFrame!=null)frame=FrameInfo(session,currentFrame,ComIdentity(current));}
        } else session.InvalidatePause();
        return Map("mode",Mode(mode),"modeValue",(int)mode,"reason",debugger.LastBreakReason.ToString(),"processes",processes,
            "lastSequence",session.Sequence,"lastDebuggerEventSequence",session.LastDebuggerEventSequence,"pauseId",session.PauseId,"currentThread",thread,"currentFrame",frame);
    }
    static Dictionary<string,object> InspectContext(Session session,Dictionary<string,object> request){
        session.EnsurePause();string expected=Text(request,"pauseId");
        if(expected!=null&&expected!=session.PauseId)throw Error("STALE_DEBUG_CONTEXT","The requested pause is no longer current.");
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
        var result=(Dictionary<string,object>)Expression(session.Dte.Debugger.GetExpression(Text(request,"expression"),false,Int(request,"expressionTimeoutMs",1000,100,10000)));
        var state=DebugStateContext(session);result["pauseId"]=session.PauseId;result["currentFrame"]=state["currentFrame"];return result;
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
