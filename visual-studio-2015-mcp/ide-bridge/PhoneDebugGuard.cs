using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EnvDTE;

internal static partial class Program {
    sealed class PhoneTargetGuard {
        public string Name,Scope;public object Value;
    }
    sealed class PhoneDebugBinding {
        public string ConfigurationToken,ProjectUniqueName,TargetPropertyName,Scope,DeviceId,ManifestPath,ManifestSha256,ApplicationId;
        public readonly List<PhoneTargetGuard> TargetGuards=new List<PhoneTargetGuard>();
    }
    static string RequiredPhoneBindingText(Dictionary<string,object> value,string name) {
        string text=Text(value,name);
        if(string.IsNullOrWhiteSpace(text)||text.Length>4096)throw Error("PHONE_BINDING_INVALID",name+" must be nonempty text of at most4096 characters.");
        return text;
    }
    static string PhoneBindingScope(Dictionary<string,object> value) {
        string scope=RequiredPhoneBindingText(value,"scope");
        if(scope!="project"&&scope!="activeConfiguration")throw Error("PHONE_BINDING_INVALID","A phone binding property scope must be project or activeConfiguration.");
        return scope;
    }
    static bool PhoneGuardScalar(object value) {
        return ScalarPropertyValue(value)&&(!(value is double)||(!double.IsNaN((double)value)&&!double.IsInfinity((double)value)))&&(!(value is float)||(!float.IsNaN((float)value)&&!float.IsInfinity((float)value)));
    }
    static PhoneDebugBinding ParsePhoneDebugBinding(Dictionary<string,object> request) {
        object raw;if(!request.TryGetValue("expectedPhoneBinding",out raw))return null;
        var value=raw as Dictionary<string,object>;
        if(value==null)throw Error("PHONE_BINDING_INVALID","expectedPhoneBinding must be an object when supplied.");
        var binding=new PhoneDebugBinding {
            ConfigurationToken=RequiredPhoneBindingText(value,"configurationToken"),ProjectUniqueName=RequiredPhoneBindingText(value,"projectUniqueName"),
            TargetPropertyName=RequiredPhoneBindingText(value,"targetPropertyName"),Scope=PhoneBindingScope(value),DeviceId=RequiredPhoneBindingText(value,"deviceId"),
            ManifestPath=RequiredPhoneBindingText(value,"manifestPath"),ManifestSha256=RequiredPhoneBindingText(value,"manifestSha256"),ApplicationId=RequiredPhoneBindingText(value,"applicationId")
        };
        Guid device;
        if(!Guid.TryParse(binding.DeviceId,out device))throw Error("PHONE_BINDING_INVALID","deviceId must be the expected CoreCon device GUID.");
        binding.DeviceId=device.ToString("D");
        if(!FullyQualifiedManifestPath(binding.ManifestPath))throw Error("PHONE_BINDING_INVALID","manifestPath must be the absolute included manifest path.");
        try{binding.ManifestPath=Path.GetFullPath(binding.ManifestPath);}catch(ArgumentException){throw Error("PHONE_BINDING_INVALID","manifestPath is invalid.");}
        if(binding.ManifestSha256.Length!=64||binding.ManifestSha256.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F'))))throw Error("PHONE_BINDING_INVALID","manifestSha256 must be an actual SHA256 hex digest.");
        binding.ManifestSha256=binding.ManifestSha256.ToLowerInvariant();
        if(value.TryGetValue("targetGuards",out raw)) {
            var guards=raw as IEnumerable;
            if(guards==null||raw is string||raw is IDictionary)throw Error("PHONE_BINDING_INVALID","targetGuards must be an array of explicit scalar property assertions.");
            var names=new HashSet<string>(StringComparer.Ordinal);
            foreach(object entry in guards) {
                if(binding.TargetGuards.Count>=32)throw Error("PHONE_BINDING_INVALID","At most32 targetGuards may be supplied.");
                var item=entry as Dictionary<string,object>;object expected;
                if(item==null||!item.TryGetValue("value",out expected)||!PhoneGuardScalar(expected))throw Error("PHONE_BINDING_INVALID","Each targetGuard requires name,scope and an explicit finite scalar value (including null).");
                var guard=new PhoneTargetGuard{Name=RequiredPhoneBindingText(item,"name"),Scope=PhoneBindingScope(item),Value=expected};
                if(!names.Add(guard.Scope+"\0"+guard.Name))throw Error("PHONE_BINDING_INVALID","Duplicate targetGuard name/scope assertions are not permitted.");
                binding.TargetGuards.Add(guard);
            }
        }
        return binding;
    }
    static void RequireSolePhoneStartup(string projectUniqueName,string[] startup) {
        if(startup==null||startup.Length!=1||!string.Equals(startup[0],projectUniqueName,StringComparison.OrdinalIgnoreCase))throw Error("PHONE_STARTUP_PROJECT_CONFLICT","The current IDE startup selection must contain only the bound project uniqueName.");
    }
    static string VerifyPhoneGuidTarget(string expected,object observed) {
        Guid wanted,actual;
        if(!Guid.TryParse(expected,out wanted)||!(observed is string)||!Guid.TryParse((string)observed,out actual)||wanted!=actual)throw Error("PHONE_DEVICE_TARGET_CONFLICT","The explicitly selected IDE device property no longer matches the bound CoreCon GUID.");
        return actual.ToString("D");
    }
    static void VerifyPhoneGuardValue(object expected,object observed) {
        if(!PhoneGuardScalar(expected)||!PhoneGuardScalar(observed))throw Error("PHONE_TARGET_GUARD_UNSUPPORTED","Phone target guards require actual finite scalar property values.");
        if(Json.Serialize(expected)!=Json.Serialize(observed))throw Error("PHONE_TARGET_GUARD_CONFLICT","An explicitly guarded IDE target property changed.");
    }
    static void VerifyPhoneManifestBinding(PhoneDebugBinding binding,Dictionary<string,object> observed) {
        if(!string.Equals(Convert.ToString(observed["projectUniqueName"]),binding.ProjectUniqueName,StringComparison.OrdinalIgnoreCase)||
           !string.Equals(Convert.ToString(observed["manifestPath"]),binding.ManifestPath,StringComparison.OrdinalIgnoreCase)||
           !string.Equals(Convert.ToString(observed["manifestSha256"]),binding.ManifestSha256,StringComparison.OrdinalIgnoreCase))throw Error("PHONE_MANIFEST_BINDING_CONFLICT","The current included project manifest identity or its byte fingerprint changed.");
        var applications=observed["applications"] as IEnumerable;int matches=0;
        if(applications!=null)foreach(object entry in applications) {
            var application=entry as Dictionary<string,object>;object id;
            if(application!=null&&application.TryGetValue("id",out id)&&id is string&&string.Equals((string)id,binding.ApplicationId,StringComparison.Ordinal))matches++;
        }
        if(matches!=1)throw Error("PHONE_APPLICATION_BINDING_CONFLICT","The selected applicationId is not a unique actual application in the bound included manifest.");
    }
    static object ReadNamedPhoneGuardProperty(Project project,string scope,string name) {
        Property selected=null;
        foreach(Property property in SelectProperties(project,scope))if(string.Equals(property.Name,name,StringComparison.Ordinal)) {
            if(selected!=null)throw Error("PHONE_TARGET_PROPERTY_AMBIGUOUS","The selected name/scope exposes multiple IDE properties.");selected=property;
        }
        if(selected==null)throw Error("PROPERTY_NOT_FOUND","The explicitly selected phone target property is absent from the current project/configuration: "+name);
        return ReadPropertyValue(selected);
    }
    static object ValidatePhoneDebugGuard(Session session,Dictionary<string,object> request) {
        var binding=ParsePhoneDebugBinding(request);if(binding==null)return null;
        var expectedConfiguration=Map("expectedConfigurationToken",binding.ConfigurationToken);
        CheckConfigurationToken(session,expectedConfiguration);
        RequireSolePhoneStartup(binding.ProjectUniqueName,StartupNames(session.Dte.Solution.SolutionBuild.StartupProjects));
        var project=SelectProject(session,binding.ProjectUniqueName);
        var manifest=(Dictionary<string,object>)ProjectAppIdentity(session,Map("projectUniqueName",project.UniqueName,"manifestPath",binding.ManifestPath));
        VerifyPhoneManifestBinding(binding,manifest);
        var cache=new Dictionary<string,object>(StringComparer.Ordinal);
        string targetKey=binding.Scope+"\0"+binding.TargetPropertyName;
        object actualTarget=ReadNamedPhoneGuardProperty(project,binding.Scope,binding.TargetPropertyName);cache.Add(targetKey,actualTarget);
        string actualDevice=VerifyPhoneGuidTarget(binding.DeviceId,actualTarget);
        var guards=new List<object>();
        foreach(var guard in binding.TargetGuards) {
            string key=guard.Scope+"\0"+guard.Name;object observed;
            if(!cache.TryGetValue(key,out observed)){observed=ReadNamedPhoneGuardProperty(project,guard.Scope,guard.Name);cache.Add(key,observed);}
            VerifyPhoneGuardValue(guard.Value,observed);guards.Add(Map("name",guard.Name,"scope",guard.Scope,"value",observed));
        }
        // This STA command prevents other bridge commands from interleaving.
        // User UI or other automation can still change the IDE. Re-observe the
        // configuration/startup immediately before returning to DebugControl;
        // this is an optimistic guard, not an IDE-wide lock.
        RequireSolePhoneStartup(project.UniqueName,StartupNames(session.Dte.Solution.SolutionBuild.StartupProjects));
        CheckConfigurationToken(session,expectedConfiguration);
        return Map("verifiedAtUtc",DateTime.UtcNow.ToString("o"),"configurationToken",binding.ConfigurationToken,"projectUniqueName",project.UniqueName,
            "deviceId",actualDevice,"targetProperty",Map("name",binding.TargetPropertyName,"scope",binding.Scope,"value",actualTarget),"targetGuards",guards,
            "manifestPath",manifest["manifestPath"],"manifestSha256",manifest["manifestSha256"],"applicationId",binding.ApplicationId,"guardScope","same-sta-dispatch-before-debug-command");
    }
}
