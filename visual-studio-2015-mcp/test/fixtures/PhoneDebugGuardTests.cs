using System;using System.Collections.Generic;using System.Reflection;using System.Web.Script.Serialization;
class PhoneDebugGuardTests {
    static Type Bridge;static int Checks;
    static Dictionary<string,object> M(params object[] pairs){var result=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)result[(string)pairs[i]]=pairs[i+1];return result;}
    static object Call(string name,params object[] args){return Bridge.GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args);}
    static void Check(bool condition,string message){if(!condition)throw new Exception(message);Checks++;}
    static void Reject(string name,string code,params object[] args){try{Call(name,args);throw new Exception("Conflicting phone guard was accepted");}catch(TargetInvocationException error){if((string)error.InnerException.Data["code"]!=code)throw;}Checks++;}
    const string Device="11111111-2222-3333-4444-555555555555",Project="Nested\\Phone.csproj",Manifest="C:\\owned\\Package.appxmanifest";
    static string Hash=new string('a',64);
    static Dictionary<string,object> Expected(){return M("configurationToken","actual-config-token","projectUniqueName",Project,"targetPropertyName","Observed.TargetGuid","scope","activeConfiguration","deviceId",Device,"manifestPath",Manifest,"manifestSha256",Hash,"applicationId","ActualApp");}
    static Dictionary<string,object> Request(Dictionary<string,object> binding){return M("expectedPhoneBinding",binding);}
    static Dictionary<string,object> Actual(){return M("projectUniqueName",Project,"manifestPath",Manifest,"manifestSha256",Hash,"applications",new object[]{M("id","ActualApp"),M("id","AnotherApp")});}
    static void Main(string[] args){
        Bridge=Assembly.LoadFrom(args[0]).GetType("Program",true);
        Check(Call("ParsePhoneDebugBinding",M())==null,"Unbound requests changed behavior");
        var value=Expected();value["deviceId"]="{"+Device.ToUpperInvariant()+"}";value["manifestSha256"]=Hash.ToUpperInvariant();object binding=Call("ParsePhoneDebugBinding",Request(value));
        Check((string)binding.GetType().GetField("DeviceId").GetValue(binding)==Device&&(string)binding.GetType().GetField("ManifestSha256").GetValue(binding)==Hash,"GUID or hash normalization changed identity");
        Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",M("expectedPhoneBinding",null));
        value=Expected();value.Remove("configurationToken");Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["manifestPath"]="Package.appxmanifest";Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["scope"]="guessed-scope";Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["deviceId"]="not-a-device-guid";Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["manifestSha256"]=new string('g',64);Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["targetGuards"]=new object[]{M("name","Actual.Target","scope","project")};Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["targetGuards"]=new object[]{M("name","Actual.Target","scope","project","value",new object[]{1})};Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();var guard=M("name","Actual.Target","scope","project","value",true);value["targetGuards"]=new object[]{guard,guard};Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();var tooMany=new object[33];for(int i=0;i<33;i++)tooMany[i]=M("name","Actual.Target"+i,"scope","project","value",i);value["targetGuards"]=tooMany;Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        value=Expected();value["targetGuards"]=new object[]{M("name","Actual.Target","scope","project","value",double.NaN)};Reject("ParsePhoneDebugBinding","PHONE_BINDING_INVALID",Request(value));
        Call("RequireSolePhoneStartup",Project,new string[]{Project.ToUpperInvariant()});Checks++;
        Reject("RequireSolePhoneStartup","PHONE_STARTUP_PROJECT_CONFLICT",Project,new string[]{Project,"Other.csproj"});
        Reject("RequireSolePhoneStartup","PHONE_STARTUP_PROJECT_CONFLICT",Project,new string[]{"Other.csproj"});
        Check((string)Call("VerifyPhoneGuidTarget",Device,"{"+Device.ToUpperInvariant()+"}")==Device,"An actual GUID property was not compared canonically");
        Reject("VerifyPhoneGuidTarget","PHONE_DEVICE_TARGET_CONFLICT",Device,"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        Reject("VerifyPhoneGuidTarget","PHONE_DEVICE_TARGET_CONFLICT",Device,123);
        Call("VerifyPhoneGuardValue",true,true);Call("VerifyPhoneGuardValue",null,null);Checks++;
        Reject("VerifyPhoneGuardValue","PHONE_TARGET_GUARD_CONFLICT",true,false);
        Reject("VerifyPhoneGuardValue","PHONE_TARGET_GUARD_CONFLICT","1",1);
        Reject("VerifyPhoneGuardValue","PHONE_TARGET_GUARD_UNSUPPORTED",true,new object[]{true});
        var actual=Actual();Call("VerifyPhoneManifestBinding",binding,actual);Checks++;
        actual=Actual();actual["manifestSha256"]=new string('b',64);Reject("VerifyPhoneManifestBinding","PHONE_MANIFEST_BINDING_CONFLICT",binding,actual);
        actual=Actual();actual["manifestPath"]="C:\\other\\Package.appxmanifest";Reject("VerifyPhoneManifestBinding","PHONE_MANIFEST_BINDING_CONFLICT",binding,actual);
        actual=Actual();actual["projectUniqueName"]="Other.csproj";Reject("VerifyPhoneManifestBinding","PHONE_MANIFEST_BINDING_CONFLICT",binding,actual);
        actual=Actual();actual["applications"]=new object[]{M("id","actualapp")};Reject("VerifyPhoneManifestBinding","PHONE_APPLICATION_BINDING_CONFLICT",binding,actual);
        actual=Actual();actual["applications"]=new object[]{M("id","ActualApp"),M("id","ActualApp")};Reject("VerifyPhoneManifestBinding","PHONE_APPLICATION_BINDING_CONFLICT",binding,actual);
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{passed=true,checks=Checks}));
    }
}
