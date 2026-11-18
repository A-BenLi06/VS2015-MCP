using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using EnvDTE;
using EnvDTE80;

internal static partial class Program {
    const string GuestIdentityPayloadHeader="VS2015MCP.GuestAppIdentity.1|";
    static string GuestIdentityExpression() {
        const string package="Windows.ApplicationModel.Package.Current.Id.";
        var fields=new List<string>{package+"Name",package+"Publisher",package+"FullName","Windows.ApplicationModel.Core.CoreApplication.Id"};
        foreach(string part in new[]{"Major","Minor","Build","Revision"})fields.Add(package+"Version."+part+".ToString(System.Globalization.CultureInfo.InvariantCulture)");
        // Standard immutable SDK properties only. Length prefixes retain exact
        // strings without delimiter or escaping assumptions. One FuncEval
        // avoids dozens of remote COM calls for separate field snapshots.
        return EncodeDebuggerStringLiteral(GuestIdentityPayloadHeader)+" + "+string.Join(" + ",fields.Select(field=>"("+field+").Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + \":\" + ("+field+")"));
    }
    static Dictionary<string,object> DecodeGuestIdentityPayload(string payload) {
        if(payload==null||payload.Length>131072||!payload.StartsWith(GuestIdentityPayloadHeader,StringComparison.Ordinal))throw Error("GUEST_APP_IDENTITY_FORMAT","The fixed SDK identity payload was absent, oversized or had an unexpected header.");
        int position=GuestIdentityPayloadHeader.Length;var values=new List<string>();
        for(int index=0;index<8;index++) {
            int colon=payload.IndexOf(':',position);int length;
            if(colon<position||colon-position>6||!int.TryParse(payload.Substring(position,colon-position),NumberStyles.None,CultureInfo.InvariantCulture,out length)||length<0||length>65535||length>payload.Length-colon-1)throw Error("GUEST_APP_IDENTITY_FORMAT","The fixed SDK identity payload contains an invalid length prefix.");
            values.Add(payload.Substring(colon+1,length));position=colon+1+length;
        }
        if(position!=payload.Length)throw Error("GUEST_APP_IDENTITY_FORMAT","The fixed SDK identity payload contains unexpected trailing data.");
        for(int index=0;index<4;index++)if(string.IsNullOrEmpty(values[index]))throw Error("GUEST_APP_IDENTITY_FORMAT","A required SDK identity string was empty.");
        var version=new ushort[4];
        for(int index=0;index<4;index++)if(!ushort.TryParse(values[index+4],NumberStyles.None,CultureInfo.InvariantCulture,out version[index]))throw Error("GUEST_APP_IDENTITY_FORMAT","A package version component is not an observed UInt16 value.");
        return Map("packageName",values[0],"publisher",values[1],"fullName",values[2],"applicationId",values[3],"version",Map("major",version[0],"minor",version[1],"build",version[2],"revision",version[3]));
    }
    static Dictionary<string,object> GuestExpressionObservation(EnvDTE.Expression expression) {
        string raw=expression.Value;bool truncated=raw!=null&&raw.Length>131072;
        return Map("type",expression.Type,"rawValue",truncated?raw.Substring(0,131072):raw,"isValidValue",expression.IsValidValue,"truncated",truncated);
    }
    static Dictionary<string,object> GuestProductIdObservation(Dictionary<string,object> observation) {
        var result=Map("available",false,"isValidValue",observation["isValidValue"],"type",observation["type"],"rawValue",observation["rawValue"],"normalizedGuid",null);
        if(!(bool)observation["isValidValue"]||(bool)observation["truncated"]){result["unavailableReason"]="The debugger did not expose a valid bounded ProductId primitive.";return result;}
        string raw=observation["rawValue"] as string;string type=observation["type"] as string;
        if(type=="string"||type=="System.String") {
            try{raw=DecodeDebuggerStringLiteral(raw);}catch(Exception){result["unavailableReason"]="The ProductId string literal could not be decoded.";return result;}
        }
        Guid guid;
        if(!Guid.TryParse(raw,out guid)){result["unavailableReason"]="The raw debugger ProductId is not an actual GUID value; no ToString or cast was assumed.";return result;}
        result["available"]=true;result["normalizedGuid"]=guid.ToString("D");return result;
    }
    static object GuestDebugAppIdentity(Session session,Dictionary<string,object> request) {
        if(Text(request,"pauseId")==null||Text(request,"frameId")==null)throw Error("INVALID_REQUEST","guestDebugAppIdentity requires the explicit current pauseId and frameId.");
        session.CheckPause(request);CheckCurrentFrame(session,request);
        string pause=session.PauseId,programKey=session.ObservedProgramIdentity;
        // Retain the observed RCWs for this entire snapshot, as well as their
        // COM identities; do not identify recycled objects by pointer alone.
        var thread=session.Dte.Debugger.CurrentThread;var frame=session.Dte.Debugger.CurrentStackFrame;
        long threadIdentity=ComIdentity(thread),frameIdentity=ComIdentity(frame);
        var observations=new List<object>();bool dispatched=false,sdkCallInFlight=false;
        var result=Map("confirmed",false,"status","unconfirmed","applicationIdentity",null,"rawProductId",null,"observations",observations,"pauseId",pause,"frameId",Text(request,"frameId"),"evaluationMayExecuteCode",true,"operationMayContinue",false);
        try {
            session.CheckSnapshot(pause,threadIdentity,frameIdentity);
            if(session.ObservedProgramIdentity!=programKey)throw Error("DEBUG_CONTEXT_CHANGED","The current debugged program changed before identity evaluation.");
            result["transport"]=GuestDebugTransport(session,request);
            result["sourceContext"]=FrameInfo(session,frame,threadIdentity);
            int timeout=Int(request,"expressionTimeoutMs",3000,100,10000);
            dispatched=true;sdkCallInFlight=true;
            var identityObservation=GuestExpressionObservation(session.Dte.Debugger.GetExpression(GuestIdentityExpression(),false,timeout));
            sdkCallInFlight=false;
            observations.Add(Map("field","fixedSdkIdentity","result",identityObservation));
            session.CheckSnapshot(pause,threadIdentity,frameIdentity);
            if(session.ObservedProgramIdentity!=programKey)throw Error("DEBUG_CONTEXT_CHANGED","The current debugged program changed during identity evaluation.");
            if(!(bool)identityObservation["isValidValue"]||(bool)identityObservation["truncated"])throw Error("GUEST_APP_IDENTITY_UNAVAILABLE","The fixed SDK identity expression did not return a valid bounded value.");
            string type=identityObservation["type"] as string;
            if(type!="string"&&type!="System.String")throw Error("GUEST_APP_IDENTITY_UNAVAILABLE","The fixed SDK identity expression did not return a string primitive.");
            var identity=DecodeGuestIdentityPayload(DecodeDebuggerStringLiteral(identityObservation["rawValue"] as string));
            if(Bool(request,"includeProductId",true)) {
                session.CheckSnapshot(pause,threadIdentity,frameIdentity);
                try {
                    sdkCallInFlight=true;
                    var product=GuestExpressionObservation(session.Dte.Debugger.GetExpression("Windows.ApplicationModel.Package.Current.Id.ProductId",false,timeout));
                    sdkCallInFlight=false;
                    observations.Add(Map("field","rawProductId","result",product));
                    session.CheckSnapshot(pause,threadIdentity,frameIdentity);
                    result["rawProductId"]=GuestProductIdObservation(product);
                } catch(Exception optionalError) {
                    session.CheckSnapshot(pause,threadIdentity,frameIdentity);
                    if(session.ObservedProgramIdentity!=programKey)throw Error("DEBUG_CONTEXT_CHANGED","The current debugged program changed during the optional ProductId observation.");
                    result["operationMayContinue"]=sdkCallInFlight||optionalError is System.Runtime.InteropServices.COMException;
                    sdkCallInFlight=false;
                    result["rawProductId"]=Map("available",false,"unavailableReason",optionalError.Message,"errorCode",optionalError.Data.Contains("code")?Convert.ToString(optionalError.Data["code"]):"GUEST_PRODUCT_ID_UNAVAILABLE");
                    observations.Add(Map("field","rawProductId","error",result["rawProductId"]));
                }
            } else result["rawProductId"]=Map("available",false,"unavailableReason","Not requested.");
            session.CheckSnapshot(pause,threadIdentity,frameIdentity);
            if(session.ObservedProgramIdentity!=programKey)throw Error("DEBUG_CONTEXT_CHANGED","The current debugged program changed after identity evaluation.");
            result["confirmed"]=true;result["status"]="observed";result["applicationIdentity"]=identity;result["programIdentityKey"]=programKey;
        } catch(Exception error) {
            string code=error.Data.Contains("code")?Convert.ToString(error.Data["code"]):"GUEST_APP_IDENTITY_EVALUATION_FAILED";
            bool contextChanged=code=="DEBUG_CONTEXT_CHANGED"||code=="STALE_DEBUG_CONTEXT"||code=="NOT_IN_BREAK_MODE"||code=="DEBUG_PROGRAM_UNAVAILABLE"||code=="DEBUG_PROGRAM_IDENTITY_UNAVAILABLE"||code=="DEBUG_PROGRAM_IDENTITY_AMBIGUOUS";
            result["error"]=Map("code",code,"message",error.Message);result["contextChanged"]=contextChanged;
            // FuncEval may run application code. A lost pause/COM response does
            // not prove the evaluation or its side effects were cancelled.
            result["operationMayContinue"]=dispatched&&(contextChanged||sdkCallInFlight||error is System.Runtime.InteropServices.COMException);
            result["applicationIdentity"]=null;
        }
        return result;
    }
}
