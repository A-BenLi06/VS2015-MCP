using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using EnvDTE;
using EnvDTE80;

internal static partial class Program {
    sealed class ProjectInventory {
        public readonly List<Project> Projects=new List<Project>();
        public readonly List<object> Rows=new List<object>();
        public readonly List<string> Warnings=new List<string>();
        public bool Truncated;
    }
    static ProjectInventory InventoryProjects(Session s) {
        var result=new ProjectInventory();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(Project project in s.Dte.Solution.Projects) VisitProject(project,null,0,result,seen);
        return result;
    }
    static void VisitProject(Project project,string parent,int depth,ProjectInventory result,HashSet<string> seen) {
        if(project==null)return;
        if(depth>32||result.Rows.Count>=1000){result.Truncated=true;return;}
        try {
            string unique=project.UniqueName,kind=project.Kind,name=project.Name;
            if(!seen.Add(unique))return;
            bool folder=string.Equals(kind,ProjectKinds.vsProjectKindSolutionFolder,StringComparison.OrdinalIgnoreCase);
            string path=null;try{path=project.FullName;}catch(COMException){}
            result.Projects.Add(project);result.Rows.Add(Map("name",name,"uniqueName",unique,"kind",kind,"fileName",path,"parentUniqueName",parent,"depth",depth,"solutionFolder",folder));
            if(folder&&project.ProjectItems!=null)foreach(ProjectItem item in project.ProjectItems){try{VisitProject(item.SubProject,unique,depth+1,result,seen);}catch(COMException error){result.Warnings.Add(error.Message);}}
        }catch(COMException error){result.Warnings.Add(error.Message);}
    }
    static string[] StartupNames(object value) {
        if(value==null)return new string[0];var array=value as IEnumerable;if(value is string)return new[]{(string)value};
        var names=new List<string>();if(array!=null)foreach(object item in array)names.Add(Convert.ToString(item));return names.ToArray();
    }
    static string ConfigurationToken(Session s) {
        var active=s.Dte.Solution.SolutionBuild.ActiveConfiguration as SolutionConfiguration2;
        string data=Json.Serialize(Map("solution",s.Dte.Solution.FullName,"name",active==null?null:active.Name,"platform",active==null?null:active.PlatformName,"startup",StartupNames(s.Dte.Solution.SolutionBuild.StartupProjects)));
        using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data))).Replace("-","").ToLowerInvariant();
    }
    static object ConfigurationInventory(Session s) {
        if(!s.Dte.Solution.IsOpen)throw Error("NO_SOLUTION","No solution is open.");
        var configurations=new List<object>();
        foreach(SolutionConfiguration item in s.Dte.Solution.SolutionBuild.SolutionConfigurations){var config=(SolutionConfiguration2)item;var contexts=new List<object>();foreach(SolutionContext context in config.SolutionContexts)contexts.Add(Map("projectName",context.ProjectName,"configurationName",context.ConfigurationName,"platformName",context.PlatformName,"shouldBuild",context.ShouldBuild,"shouldDeploy",context.ShouldDeploy));configurations.Add(Map("name",config.Name,"platform",config.PlatformName,"contexts",contexts));}
        var inventory=InventoryProjects(s);var active=(SolutionConfiguration2)s.Dte.Solution.SolutionBuild.ActiveConfiguration;
        return Map("configurations",configurations,"activeConfiguration",active.Name,"activePlatform",active.PlatformName,"startupProjects",StartupNames(s.Dte.Solution.SolutionBuild.StartupProjects),"configurationToken",ConfigurationToken(s),"projects",inventory.Rows,"warnings",inventory.Warnings,"truncated",inventory.Truncated);
    }
    static void CheckConfigurationToken(Session s,Dictionary<string,object> request) {
        string expected=Text(request,"expectedConfigurationToken");if(string.IsNullOrEmpty(expected)||expected!=ConfigurationToken(s))throw Error("CONFIGURATION_CONFLICT","The active IDE configuration or startup projects changed; re-read configurations before modifying them.");
    }
    static object ConfigureSolution(Session s,Dictionary<string,object> request) {
        RequireDesign(s);if(s.ActiveBuild!=null||s.Dte.Solution.SolutionBuild.BuildState==vsBuildState.vsBuildStateInProgress)throw Error("BUILD_BUSY","Wait for the current build before configuring the solution.");
        CheckConfigurationToken(s,request);
        string name=Text(request,"configuration"),platform=Text(request,"platform");
        var builder=s.Dte.Solution.SolutionBuild;var previous=(SolutionConfiguration2)builder.ActiveConfiguration;object previousStartup=builder.StartupProjects;SolutionConfiguration2 selected=null;
        foreach(SolutionConfiguration item in builder.SolutionConfigurations){var config=(SolutionConfiguration2)item;if(config.Name==name&&config.PlatformName==platform){if(selected!=null)throw Error("AMBIGUOUS_CONFIGURATION","Configuration/platform must identify exactly one installed solution configuration.");selected=config;}}
        if(selected==null)throw Error("CONFIGURATION_NOT_FOUND","Choose an actual configuration/platform pair from configurations.");
        string[] startup=null;object raw;
        if(request.TryGetValue("startupProjects",out raw)) {
            var values=raw as IEnumerable;if(values==null||raw is string)throw Error("INVALID_REQUEST","startupProjects must be an array of project unique names.");
            startup=StartupNames(raw);if(startup.Length<1||startup.Length>32||startup.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=startup.Length)throw Error("INVALID_REQUEST","Select one to 32 distinct startup projects.");
            var inventory=InventoryProjects(s);
            foreach(string key in startup){var matches=inventory.Projects.Where(p=>string.Equals(p.UniqueName,key,StringComparison.OrdinalIgnoreCase)&&!string.Equals(p.Kind,ProjectKinds.vsProjectKindSolutionFolder,StringComparison.OrdinalIgnoreCase)).ToArray();if(matches.Length!=1)throw Error("PROJECT_NOT_FOUND","Select a real project uniqueName, not a folder or display name: "+key);}
        }
        try {selected.Activate();if(startup!=null)builder.StartupProjects=startup;}
        catch(Exception error) {string rollback=null;try{previous.Activate();builder.StartupProjects=previousStartup;}catch(Exception failure){rollback=failure.Message;}throw Error(rollback==null?"CONFIGURATION_CHANGE_FAILED":"CONFIGURATION_ROLLBACK_FAILED",error.Message+(rollback==null?" Previous state restored.":" Rollback failed: "+rollback));}
        return ConfigurationInventory(s);
    }
    static Project SelectProject(Session s,string uniqueName) {
        var inventory=InventoryProjects(s);var matches=inventory.Projects.Where(p=>string.Equals(p.UniqueName,uniqueName,StringComparison.OrdinalIgnoreCase)&&!string.Equals(p.Kind,ProjectKinds.vsProjectKindSolutionFolder,StringComparison.OrdinalIgnoreCase)).ToArray();
        if(matches.Length!=1)throw Error("PROJECT_NOT_FOUND","Select an actual uniqueName from the recursive project inventory.");return matches[0];
    }
    static Properties SelectProperties(Project project,string scope) {
        if(scope=="project")return project.Properties;
        if(scope=="activeConfiguration")return project.ConfigurationManager.ActiveConfiguration.Properties;
        throw Error("INVALID_REQUEST","Property scope must be project or activeConfiguration.");
    }
    static bool ScalarPropertyValue(object value) {
        return value==null||value is string||value is bool||value is byte||value is short||value is int||value is long||value is ushort||value is uint||value is ulong||value is float||value is double||value is decimal;
    }
    static object ReadPropertyValue(Property property) {
        if(property.NumIndices!=0)throw Error("INDEXED_PROPERTY","This property requires indices and cannot be read through the scalar property interface.");
        object value=property.Value;if(ScalarPropertyValue(value))return value;
        var array=value as Array;if(array!=null&&array.Length<=256){foreach(object item in array)if(!ScalarPropertyValue(item))throw Error("PROPERTY_VALUE_UNSUPPORTED","This property contains non-scalar objects.");return array;}
        throw Error("PROPERTY_VALUE_UNSUPPORTED","This property does not expose a JSON scalar or bounded scalar array.");
    }
    static object ProjectProperties(Session s,Dictionary<string,object> request) {
        var project=SelectProject(s,Text(request,"projectUniqueName"));string scope=Text(request,"scope","activeConfiguration"),name=Text(request,"propertyName");var properties=SelectProperties(project,scope);var rows=new List<object>();int limit=Int(request,"limit",100,1,500);
        foreach(Property property in properties) {
            if(name!=null&&property.Name!=name)continue;if(rows.Count>=limit)break;
            try{rows.Add(Map("name",property.Name,"value",ReadPropertyValue(property),"available",true,"indexCount",property.NumIndices));}
            catch(Exception error){rows.Add(Map("name",property.Name,"available",false,"error",error.Message));}
        }
        if(name!=null&&rows.Count==0)throw Error("PROPERTY_NOT_FOUND","The selected project/configuration does not expose this property.");
        return Map("projectUniqueName",project.UniqueName,"scope",scope,"properties",rows,"configurationToken",ConfigurationToken(s),"limit",limit);
    }
    static object SetProjectProperty(Session s,Dictionary<string,object> request) {
        RequireDesign(s);if(s.ActiveBuild!=null||s.Dte.Solution.SolutionBuild.BuildState==vsBuildState.vsBuildStateInProgress)throw Error("BUILD_BUSY","Wait for the build before changing project properties.");CheckConfigurationToken(s,request);
        var project=SelectProject(s,Text(request,"projectUniqueName"));string scope=Text(request,"scope","activeConfiguration"),name=Text(request,"propertyName");Property selected=null;foreach(Property property in SelectProperties(project,scope))if(property.Name==name){selected=property;break;}
        if(selected==null)throw Error("PROPERTY_NOT_FOUND","The selected project/configuration does not expose this property.");
        object expected,replacement;if(!request.TryGetValue("expectedValue",out expected)||!request.TryGetValue("value",out replacement))throw Error("INVALID_REQUEST","expectedValue and value are required.");
        if(!ScalarPropertyValue(expected)||!ScalarPropertyValue(replacement))throw Error("PROPERTY_VALUE_UNSUPPORTED","Property mutations require explicit scalar values.");
        object before=ReadPropertyValue(selected);if(Json.Serialize(before)!=Json.Serialize(expected))throw Error("PROPERTY_CONFLICT","The property changed; read its current value before setting it.");
        selected.Value=replacement;object actual=selected.Value;if(Json.Serialize(actual)!=Json.Serialize(replacement))throw Error("PROPERTY_VERIFY_FAILED","The project returned a different value after setting it; inspect current state before retrying.");
        return Map("projectUniqueName",project.UniqueName,"scope",scope,"propertyName",name,"value",actual,"configurationToken",ConfigurationToken(s));
    }
    static object StartProjectBuild(Session s,Dictionary<string,object> request) {
        RequireDesign(s);CheckConfigurationToken(s,request);
        if(s.ActiveBuild!=null||s.Dte.Solution.SolutionBuild.BuildState==vsBuildState.vsBuildStateInProgress)throw Error("BUILD_BUSY","An IDE build is already in progress.");
        var project=SelectProject(s,Text(request,"projectUniqueName"));string action=Text(request,"action","build");if(action!="build"&&action!="deploy")throw Error("INVALID_REQUEST","Project action must be build or deploy.");
        var active=(SolutionConfiguration2)s.Dte.Solution.SolutionBuild.ActiveConfiguration;
        var job=new BuildJob{Id=Guid.NewGuid().ToString(),Action=action,Phase=action,State="started",StartedUtc=DateTime.UtcNow.ToString("o"),ProjectUniqueName=project.UniqueName,ExpectedScope=vsBuildScope.vsBuildScopeProject,Configuration=active.Name,Platform=active.PlatformName};
        s.TrackBuild(job);s.ActiveBuild=job;
        try{if(action=="build")s.Dte.Solution.SolutionBuild.BuildProject(active.Name,project.UniqueName,false);else ((SolutionBuild2)s.Dte.Solution.SolutionBuild).DeployProject(active.Name,project.UniqueName,false);}
        catch{job.State="start-failed";job.Complete=false;s.ActiveBuild=null;throw;}
        return job.Info();
    }
    static object RecursiveSolutionStatus(Session s) {
        var solution=s.Dte.Solution;var projects=InventoryProjects(s);string name=null,platform=null;string token=null;object startup=null;
        if(solution.IsOpen){var active=(SolutionConfiguration2)solution.SolutionBuild.ActiveConfiguration;name=active.Name;platform=active.PlatformName;token=ConfigurationToken(s);startup=StartupNames(solution.SolutionBuild.StartupProjects);}
        return Map("sessionId",s.Id,"isOpen",solution.IsOpen,"fullName",solution.FullName,"saved",solution.Saved,"activeConfiguration",name,"activePlatform",platform,"startupProjects",startup,"configurationToken",token,"projects",projects.Rows,"projectWarnings",projects.Warnings,"projectsTruncated",projects.Truncated,"buildState",solution.SolutionBuild.BuildState.ToString(),"debugger",DebugState(s));
    }
}
