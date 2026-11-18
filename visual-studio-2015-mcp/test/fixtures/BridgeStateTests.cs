using System;
using System.Reflection;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Test-owned state harness: no production endpoint injects fake build events.
class BridgeStateTests {
    static Type ProgramType;
    static Dictionary<string,object> Values(params object[] values) {
        var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)result[(string)values[i]]=values[i+1];return result;
    }
    static object Call(string operation,Dictionary<string,object> request) {
        request["operation"]=operation;return ProgramType.GetMethod("Dispatch",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{request});
    }
    static void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
    static object NewJob(Type type,string action) {
        var job=Activator.CreateInstance(type,true);
        foreach(var value in Values("Id",Guid.NewGuid().ToString(),"Action",action,"Phase",action,"State","started","StartedUtc",DateTime.UtcNow.ToString("o")))type.GetField(value.Key).SetValue(job,value.Value);
        return job;
    }
    static object EnumValue(string name,string value) {return Enum.Parse(Type.GetType("EnvDTE."+name+", EnvDTE",true),value);}
    static Dictionary<string,object> DeploySequence(object session,Type sessionType,Type jobType,string sid) {
        var active=sessionType.GetField("ActiveBuild");var job=NewJob(jobType,"deploy");
        sessionType.GetMethod("TrackBuild").Invoke(session,new[]{job});active.SetValue(session,job);
        var begin=sessionType.GetMethod("BeginBuild",BindingFlags.Instance|BindingFlags.NonPublic);
        var done=sessionType.GetMethod("DoneBuild",BindingFlags.Instance|BindingFlags.NonPublic);
        object scope=EnumValue("vsBuildScope","vsBuildScopeSolution"),build=EnumValue("vsBuildAction","vsBuildActionBuild"),deploy=EnumValue("vsBuildAction","vsBuildActionDeploy");
        begin.Invoke(session,new[]{scope,build});Assert((bool)jobType.GetField("SawBegin").GetValue(job),"Deploy preparation begin was ignored");
        done.Invoke(session,new[]{scope,build});Assert(!(bool)jobType.GetField("Complete").GetValue(job)&&object.ReferenceEquals(active.GetValue(session),job),"Preparation was mistaken for deployment completion");
        done.Invoke(session,new[]{scope,deploy});Assert((bool)jobType.GetField("Complete").GetValue(job)&&active.GetValue(session)==null,"Final deployment event did not complete the operation");
        var incomplete=NewJob(jobType,"deploy");sessionType.GetMethod("TrackBuild").Invoke(session,new[]{incomplete});active.SetValue(session,incomplete);
        begin.Invoke(session,new[]{scope,build});done.Invoke(session,new[]{scope,build});
        var reconciled=(Dictionary<string,object>)Call("buildReconcile",Values("sessionId",sid,"buildId",jobType.GetField("Id").GetValue(incomplete)));
        Assert(!(bool)reconciled["complete"]&&(string)reconciled["state"]=="unconfirmed","Missing Deploy completion invented success");
        return Values("beginAccepted",true,"preparationNotCompletion",true,"deployDoneAccepted",true,"missingDeployUnconfirmed",true);
    }
    [STAThread]static void Main(string[] args) {
        ProgramType=Assembly.LoadFrom(args[2]).GetType("Program",true);string sid=null;
        try {
            var attached=(Dictionary<string,object>)Call("attach",Values("processId",int.Parse(args[0]),"expectedStartTimeUtc",args[1]));sid=(string)attached["sessionId"];
            var sessions=(IDictionary)ProgramType.GetField("Sessions",BindingFlags.Static|BindingFlags.NonPublic).GetValue(null);var session=sessions[sid];var sessionType=session.GetType();var jobType=ProgramType.GetNestedType("BuildJob",BindingFlags.NonPublic);
            object last=null;string first=null;
            for(int i=0;i<70;i++) {
                var job=NewJob(jobType,"build");if(i==0)first=(string)jobType.GetField("Id").GetValue(job);
                jobType.GetField("State").SetValue(job,"succeeded");jobType.GetField("Complete").SetValue(job,true);
                sessionType.GetMethod("TrackBuild").Invoke(session,new[]{job});last=job;
            }
            var builds=(IDictionary)sessionType.GetField("Builds").GetValue(session);Assert(builds.Count==64,"Build history not bounded");Assert(!builds.Contains(first),"Old build retained");
            int evicted=(int)sessionType.GetField("EvictedBuilds").GetValue(session);
            jobType.GetField("State").SetValue(last,"started");jobType.GetField("Complete").SetValue(last,false);jobType.GetField("LastBuildInfo").SetValue(last,3);sessionType.GetField("ActiveBuild").SetValue(session,last);
            var result=(Dictionary<string,object>)Call("buildReconcile",Values("sessionId",sid,"buildId",jobType.GetField("Id").GetValue(last)));
            Assert((bool)result["reconciled"],"Did not reconcile");Assert((string)result["state"]=="unconfirmed"&&!(bool)result["complete"]&&result["lastBuildInfo"]==null,"Reconciliation invented outcome");Assert(sessionType.GetField("ActiveBuild").GetValue(session)==null,"Active build stayed locked");
            var deployment=DeploySequence(session,sessionType,jobType,sid);
            Console.WriteLine(new JavaScriptSerializer().Serialize(Values("passed",true,"builds",builds.Count,"evicted",evicted,"reconciled",result,"deployment",deployment)));
        } finally {if(sid!=null)Call("detach",Values("sessionId",sid));}
    }
}
