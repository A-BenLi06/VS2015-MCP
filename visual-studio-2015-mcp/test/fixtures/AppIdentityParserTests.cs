using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

class AppIdentityParserTests {
    static Type Bridge;
    static int Checks;
    const string Old="http://schemas.microsoft.com/appx/2010/manifest";
    const string Modern="http://schemas.microsoft.com/appx/manifest/foundation/windows10";
    const string Phone="http://schemas.microsoft.com/appx/2014/phone/manifest";
    static void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
    static Dictionary<string,object> Parse(byte[] bytes){return (Dictionary<string,object>)Bridge.GetMethod("ParseAppxIdentity",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{bytes});}
    static Dictionary<string,object> Parse(string xml){return Parse(Encoding.UTF8.GetBytes(xml));}
    static string Manifest(string ns,string body){return "<Package xmlns='"+ns+"' xmlns:mp='"+Phone+"'>"+body+"</Package>";}
    static string Identity="<Identity Name='actual.package' Publisher='CN=Actual Publisher' Version='1.2.3.4'/>";
    static string PhoneIdentity="<mp:PhoneIdentity PhoneProductId='11111111-2222-3333-4444-555555555555' PhonePublisherId='00000000-0000-0000-0000-000000000000'/>";
    static void Reject(string xml,string expected){try{Parse(xml);throw new Exception("Invalid manifest was accepted");}catch(TargetInvocationException error){Assert((string)error.InnerException.Data["code"]==expected,"Unexpected error: "+error.InnerException.Message);}Checks++;}
    static void Main(string[] args) {
        Bridge=Assembly.LoadFrom(args[0]).GetType("Program",true);
        string oldXml=Manifest(Old,Identity+PhoneIdentity+"<Applications><Application Id='RealId' Executable='$targetnametoken$.exe' EntryPoint='Actual.App'/></Applications>");
        var old=Parse(oldXml);var package=(Dictionary<string,object>)old["packageIdentity"];var phone=(Dictionary<string,object>)old["phoneIdentity"];
        Assert((string)old["manifestNamespace"]==Old&&(string)package["name"]=="actual.package"&&(string)phone["phoneProductId"]=="11111111-2222-3333-4444-555555555555","Actual WP8.1 identity did not survive");Checks++;
        Assert((string)package["publisher"]=="CN=Actual Publisher"&&(string)package["version"]=="1.2.3.4"&&package["processorArchitecture"]==null,"Identity defaults were invented");Checks++;
        var apps=(IList)old["applications"];var app=(Dictionary<string,object>)apps[0];Assert((string)app["id"]=="RealId"&&(string)app["executable"]=="$targetnametoken$.exe","Actual application fields changed");Checks++;
        var modern=Parse(Manifest(Modern,Identity+"<Applications><Application Id='First'/><Application Id='Second'/></Applications>"));Assert(modern["phoneIdentity"]==null&&((IList)modern["applications"]).Count==2,"Modern app identities were inferred or collapsed");Checks++;
        string resource=Manifest(Old,Identity);Assert(((IList)Parse(resource)["applications"]).Count==0,"An application ID was invented for a resource package");Checks++;
        var foreign=Parse(Manifest(Old,Identity+"<fake:PhoneIdentity xmlns:fake='urn:foreign' PhoneProductId='11111111-2222-3333-4444-555555555555'/>"));Assert(foreign["phoneIdentity"]==null,"Foreign namespace phone identity was accepted");Checks++;
        Reject(Manifest("urn:fake",Identity),"APP_MANIFEST_SCHEMA_UNSUPPORTED");
        Reject(Manifest(Old,Identity+Identity),"APP_MANIFEST_INVALID");
        Reject(Manifest(Old,"<Identity Name='missing.publisher' Version='1.0.0.0'/>"),"APP_MANIFEST_INVALID");
        Reject(Manifest(Old,Identity+"<Applications><Application Id='Same'/><Application Id='Same'/></Applications>"),"APP_MANIFEST_INVALID");
        Reject(Manifest(Old,Identity+PhoneIdentity.Replace("11111111-2222-3333-4444-555555555555","not-a-guid")),"APP_MANIFEST_INVALID");
        Reject("<!DOCTYPE Package [<!ENTITY xxe SYSTEM 'file:///C:/does-not-exist.txt'>]>"+Manifest(Old,Identity),"APP_MANIFEST_XML_INVALID");
        Reject("<!DOCTYPE Package [<!ENTITY test 'text'>]>"+Manifest(Old,Identity),"APP_MANIFEST_XML_INVALID");
        byte[] content=Encoding.UTF8.GetBytes(oldXml);using(var sha=SHA256.Create()){string expected=BitConverter.ToString(sha.ComputeHash(content)).Replace("-","").ToLowerInvariant();Assert((string)old["manifestSha256"]==expected&&(int)old["manifestBytes"]==content.Length,"Fingerprint does not describe the parsed byte snapshot");}Checks++;
        string unicodeXml=Manifest(Modern,Identity.Replace("Actual Publisher","真实发布者"));byte[] preamble=Encoding.Unicode.GetPreamble(),body=Encoding.Unicode.GetBytes(unicodeXml),utf16=new byte[preamble.Length+body.Length];Buffer.BlockCopy(preamble,0,utf16,0,preamble.Length);Buffer.BlockCopy(body,0,utf16,preamble.Length,body.Length);
        Assert((string)((Dictionary<string,object>)Parse(utf16)["packageIdentity"])["publisher"]=="CN=真实发布者","UTF16 XML encoding or actual identity was lost");Checks++;
        var namespaces=(IList)old["namespaceDeclarations"];bool defaultFound=false,phoneFound=false;foreach(Dictionary<string,object> declaration in namespaces){if((string)declaration["prefix"]==""&&(string)declaration["namespaceUri"]==Old)defaultFound=true;if((string)declaration["prefix"]=="mp"&&(string)declaration["namespaceUri"]==Phone)phoneFound=true;}Assert(defaultFound&&phoneFound,"Actual namespace declarations missing");Checks++;
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{passed=true,checks=Checks}));
    }
}
