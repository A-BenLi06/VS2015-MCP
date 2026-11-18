using System;using System.Collections.Generic;using System.Reflection;using System.Text;using System.Web.Script.Serialization;
class GuestIdentityTests {
    static Type Bridge;static int Checks;
    static object Call(string method,params object[] arguments){return Bridge.GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,arguments);}
    static void Check(bool condition,string message){if(!condition)throw new Exception(message);Checks++;}
    static void Reject(string method,string value,string code){try{Call(method,value);throw new Exception("Invalid primitive was accepted");}catch(TargetInvocationException error){if((string)error.InnerException.Data["code"]!=code)throw;}Checks++;}
    static string Payload(params string[] values){var text=new StringBuilder("VS2015MCP.GuestAppIdentity.1|");foreach(string value in values)text.Append(value.Length).Append(':').Append(value);return text.ToString();}
    static Dictionary<string,object> Observation(string type,string raw,bool valid){return new Dictionary<string,object>{{"type",type},{"rawValue",raw},{"isValidValue",valid},{"truncated",false}};}
    static void Main(string[] arguments){
        Bridge=Assembly.LoadFrom(arguments[0]).GetType("Program",true);
        string payload=Payload("actual.name","CN=测试|:😀","actual.fullname_1.2.3.4_x86__hash","ActualApp","1","2","3","4");
        var identity=(Dictionary<string,object>)Call("DecodeGuestIdentityPayload",payload);
        Check((string)identity["publisher"]=="CN=测试|:😀"&&(string)identity["applicationId"]=="ActualApp","Length prefixes did not preserve UTF16/delimiters");
        var version=(Dictionary<string,object>)identity["version"];Check(Convert.ToInt32(version["major"])==1&&Convert.ToInt32(version["revision"])==4,"Version was inferred or misparsed");
        Reject("DecodeGuestIdentityPayload",payload+"trailing","GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",payload.Substring(0,payload.Length-1),"GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",payload.Replace("VS2015MCP.GuestAppIdentity.1|","unknown|"),"GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",Payload("","publisher","full","App","1","0","0","0"),"GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",Payload("name","publisher","full","App","65536","0","0","0"),"GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",Payload("name","publisher","full","App","-1","0","0","0"),"GUEST_APP_IDENTITY_FORMAT");
        Reject("DecodeGuestIdentityPayload",Payload("name","publisher","full","App","0x10","0","0","0"),"GUEST_APP_IDENTITY_FORMAT");
        identity=(Dictionary<string,object>)Call("DecodeGuestIdentityPayload",Payload("name","publisher","full","App","65535","0","0","0"));Check(Convert.ToInt32(((Dictionary<string,object>)identity["version"])["major"])==65535,"UInt16 maximum rejected");
        string special="quote\" slash\\ nul\0 bell\a back\b form\f line\n return\r tab\t vert\v 中文 😀\u2028";
        string encoded=(string)Call("EncodeDebuggerStringLiteral",special);Check((string)Call("DecodeDebuggerStringLiteral",encoded)==special,"Shared debugger literal round-trip failed");
        Check((string)Call("DecodeDebuggerStringLiteral","\"\\u4e2d\\U0001f600\\x41\"")=="中😀A","Unicode debugger literal decode failed");
        Check((string)Call("DecodeDebuggerStringLiteral","@\"quoted \"\"text\"\"\"")=="quoted \"text\"","Verbatim string decode failed");
        Reject("DecodeDebuggerStringLiteral","\"prefix\" trailing","DEBUGGER_LITERAL_FORMAT");
        Reject("DecodeDebuggerStringLiteral","\"\\U00110000\"","DEBUGGER_LITERAL_FORMAT");
        Reject("DecodeDebuggerStringLiteral","\"\\U0000d800\"","DEBUGGER_LITERAL_FORMAT");
        Reject("DecodeDebuggerStringLiteral","\"\\unknown\"","DEBUGGER_LITERAL_FORMAT");
        var product=(Dictionary<string,object>)Call("GuestProductIdObservation",Observation("System.Guid","{11111111-2222-3333-4444-555555555555}",true));Check((bool)product["available"]&&(string)product["normalizedGuid"]=="11111111-2222-3333-4444-555555555555","Actual raw GUID was lost");
        product=(Dictionary<string,object>)Call("GuestProductIdObservation",Observation("System.Guid","{System.Guid}",true));Check(!(bool)product["available"]&&product["normalizedGuid"]==null,"Debugger object display was invented into a GUID");
        product=(Dictionary<string,object>)Call("GuestProductIdObservation",Observation("string","\"11111111-2222-3333-4444-555555555555\"",true));Check((bool)product["available"],"Actual quoted GUID was not decoded");
        product=(Dictionary<string,object>)Call("GuestProductIdObservation",Observation("System.Guid","InvalidCastException",false));Check(!(bool)product["available"]&&!(bool)product["isValidValue"],"Invalid ProductId was reported available");
        string expression=(string)Call("GuestIdentityExpression");Check(expression.Contains("Windows.ApplicationModel.Package.Current.Id.Name")&&expression.Contains("Windows.ApplicationModel.Core.CoreApplication.Id")&&!expression.Contains("ProductId")&&!expression.Contains("Invoke("),"Fixed SDK expression scope changed");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{passed=true,checks=Checks}));
    }
}
