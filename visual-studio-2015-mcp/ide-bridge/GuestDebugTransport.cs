using EnvDTE80;
using System.Collections.Generic;

internal static partial class Program {
    static object GuestDebugTransport(Session session,Dictionary<string,object> request) {
        session.EnsurePause();CheckCurrentFrame(session,request);
        string pause=session.PauseId;
        var debugger=session.Dte.Debugger;var currentThread=debugger.CurrentThread;var currentFrame=debugger.CurrentStackFrame;
        var program=debugger.CurrentProgram;var process=program.Process as Process2;
        if(process==null||process.Transport==null)throw Error("DEBUG_TRANSPORT_UNAVAILABLE","The current debuggee does not expose Process2 transport metadata.");
        var result=Map("pauseId",pause,"programIdentityKey",session.ObservedProgramIdentity,"programName",program.Name,"processId",process.ProcessID,"processName",process.Name,"transportId",process.Transport.ID,"transportName",process.Transport.Name,"transportQualifier",process.TransportQualifier,"userName",process.UserName);
        session.CheckSnapshot(pause,DebugObjectIdentity(currentThread),DebugObjectIdentity(currentFrame));
        return result;
    }
}
