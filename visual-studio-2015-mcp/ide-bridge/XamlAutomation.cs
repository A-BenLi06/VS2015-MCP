using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using EnvDTE;

// Generic in-debuggee WinRT XAML inspection. No guest helper, private app API,
// arbitrary caller expression, host UIA tree, or target SDK reference is used.
internal static partial class Program {
    const string XamlRoot = "Windows.UI.Xaml.Window.Current.Content";
    sealed class XamlContext {
        public string PauseId, ProgramKey;
        public long ThreadIdentity, FrameIdentity;
        public readonly EnvDTE.Thread ThreadValue;
        public readonly EnvDTE.StackFrame FrameValue;
        public long QueryDeadline;
        public int NativeThreadId;
        public XamlContext(Session s) {
            s.EnsurePause(); PauseId=s.PauseId;
            ProgramKey=s.ObservedProgramIdentity;
            ThreadValue=s.Dte.Debugger.CurrentThread;FrameValue=s.Dte.Debugger.CurrentStackFrame;
            ThreadIdentity=ComIdentity(ThreadValue);FrameIdentity=ComIdentity(FrameValue);NativeThreadId=ThreadValue.ID;
        }
        public void Check(Session s) {
            s.CheckIdentity(); s.EnsurePause();
            string program=s.ObservedProgramIdentity;long thread=ComIdentity(s.Dte.Debugger.CurrentThread),frame=ComIdentity(s.Dte.Debugger.CurrentStackFrame);
            if(s.PauseId!=PauseId || program!=ProgramKey || thread!=ThreadIdentity || frame!=FrameIdentity)
                throw Error("STALE_XAML_CONTEXT","Paused program, thread, frame or execution epoch changed. Read the XAML tree again. "+Json.Serialize(Map("pauseBefore",PauseId,"pauseNow",s.PauseId,"sameProgram",program==ProgramKey,"threadBefore",ThreadIdentity,"threadNow",thread,"frameBefore",FrameIdentity,"frameNow",frame)));
        }
    }
    sealed class XamlNodeRecord {
        public string Id=Guid.NewGuid().ToString(), SnapshotId, Type, Name, AutomationId, IdentityHash, Text;
        public int ChildCount;
        public bool TextAvailable;
        public XamlContext Context;
        public int[] Path;
    }
    sealed partial class Session {
        public readonly Dictionary<string,XamlNodeRecord> XamlNodes=new Dictionary<string,XamlNodeRecord>();
        partial void OnInvalidatePause() { InvalidateXamlContext(); }
        public void InvalidateXamlContext(){XamlNodes.Clear();}
    }
    static string XamlPath(int[] indices) {
        string value=XamlRoot;
        foreach(int index in indices){if(index<0)throw Error("INVALID_REQUEST","Visual child indices must be nonnegative.");value="Windows.UI.Xaml.Media.VisualTreeHelper.GetChild("+value+", "+index.ToString(CultureInfo.InvariantCulture)+")";}
        return value;
    }
    // DTE returns C# debugger string literals, which are not always JSON strings.
    // Delegate to the shared strict literal parser/encoder while preserving XAML error codes.
    static string DecodeXamlString(string value) {
        try { return DecodeDebuggerStringLiteral(value); }
        catch(InvalidOperationException error) {
            if(Convert.ToString(error.Data["code"])=="DEBUGGER_LITERAL_FORMAT")throw Error("XAML_VALUE_FORMAT",error.Message);
            throw;
        }
    }
    static string XamlLiteral(string value) { return EncodeDebuggerStringLiteral(value); }
    static string XamlRaw(Session s,XamlContext context,string expression,int timeout) {
        if(context.QueryDeadline>0&&Stopwatch.GetTimestamp()>=context.QueryDeadline)throw Error("XAML_QUERY_TIMEOUT","XAML query exhausted its independent query time budget.");
        context.Check(s);
        if(context.QueryDeadline>0&&Stopwatch.GetTimestamp()>=context.QueryDeadline)throw Error("XAML_QUERY_TIMEOUT","XAML query exhausted its independent query time budget.");
        EnvDTE.Expression value=null;
        try {
            value=s.Dte.Debugger.GetExpression(expression,false,timeout);
            bool valid=value.IsValidValue;string raw=value.Value;
            context.Check(s);
            if(!valid)throw Error("XAML_EVALUATION_FAILED","SDK expression could not be evaluated: "+Limit(expression,2048)+"; "+Limit(raw,2048));
            if(raw==null||raw.Length>16384)throw Error("XAML_VALUE_FORMAT","The debugger returned an absent or oversized primitive value.");
            return raw;
        } finally {ReleaseXamlCom(value);}
    }
    static void ReleaseXamlCom(object value){if(value!=null&&System.Runtime.InteropServices.Marshal.IsComObject(value))System.Runtime.InteropServices.Marshal.ReleaseComObject(value);}
    static string XamlString(Session s,XamlContext context,string expression,int timeout){return DecodeXamlString(XamlRaw(s,context,expression,timeout));}
    static bool XamlBool(Session s,XamlContext context,string expression,int timeout){string raw=XamlRaw(s,context,expression,timeout);if(raw=="true")return true;if(raw=="false")return false;throw Error("XAML_VALUE_FORMAT","The debugger did not return a Boolean primitive.");}
    static int DecodeXamlInt(string raw){int number;uint hex;if(raw!=null&&raw.StartsWith("0x",StringComparison.OrdinalIgnoreCase)&&raw.Length<=10&&uint.TryParse(raw.Substring(2),NumberStyles.AllowHexSpecifier,CultureInfo.InvariantCulture,out hex))return unchecked((int)hex);if(!int.TryParse(raw,NumberStyles.AllowLeadingSign,CultureInfo.InvariantCulture,out number))throw Error("XAML_VALUE_FORMAT","The debugger did not return an Int32 primitive.");return number;}
    static int XamlInt(Session s,XamlContext context,string expression,int timeout){return DecodeXamlInt(XamlRaw(s,context,expression,timeout));}
    static void RequireXamlThread(Session s,XamlContext context,int timeout) {
        if(!XamlBool(s,context,"Windows.UI.Xaml.Window.Current != null && Windows.UI.Xaml.Window.Current.Dispatcher.HasThreadAccess",timeout))
            throw Error("XAML_UI_THREAD_REQUIRED","Select a managed frame paused on the WinRT XAML UI thread before inspecting its visual tree.");
    }
    static string XamlBase64Expression(string value){return "System.Convert.ToBase64String(new System.Text.UTF8Encoding(false, true).GetBytes("+value+"))";}
    static string DecodeXamlBase64(string value) {
        try{return new UTF8Encoding(false,true).GetString(Convert.FromBase64String(value));}
        catch(Exception error){if(!(error is FormatException)&&!(error is DecoderFallbackException))throw;throw Error("XAML_VALUE_FORMAT","The SDK aggregate did not return a valid UTF-8 base64 field.");}
    }
    static XamlNodeRecord ReadXamlNode(Session s,XamlContext context,int[] path,int timeout) {
        string x=XamlPath(path);
        string text="("+x+" is Windows.UI.Xaml.Controls.TextBlock ? ((Windows.UI.Xaml.Controls.TextBlock)("+x+")).Text : "+x+" is Windows.UI.Xaml.Controls.TextBox ? ((Windows.UI.Xaml.Controls.TextBox)("+x+")).Text : "+x+" is Windows.UI.Xaml.Controls.ContentControl ? ((Windows.UI.Xaml.Controls.ContentControl)("+x+")).Content as string : null)";
        // One standard SDK expression returns only a string primitive. Encoding each
        // arbitrary text field avoids delimiter/quote ambiguity without a guest helper.
        string expression=XamlBase64Expression("("+x+").GetType().FullName")+
            "+\"|\"+System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode((object)("+x+")).ToString(System.Globalization.CultureInfo.InvariantCulture)"+
            "+\"|\"+Windows.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount("+x+").ToString(System.Globalization.CultureInfo.InvariantCulture)"+
            "+\"|\"+"+XamlBase64Expression("((Windows.UI.Xaml.FrameworkElement)("+x+")).Name ?? \"\"")+
            "+\"|\"+"+XamlBase64Expression("Windows.UI.Xaml.Automation.AutomationProperties.GetAutomationId("+x+") ?? \"\"")+
            "+\"|\"+("+text+" == null ? \"-\" : "+XamlBase64Expression(text)+")";
        string[] fields=XamlString(s,context,expression,timeout).Split('|');
        if(fields.Length!=6)throw Error("XAML_VALUE_FORMAT","The SDK aggregate returned the wrong number of fields.");
        int hash=DecodeXamlInt(fields[1]),count=DecodeXamlInt(fields[2]);
        if(count<0)throw Error("XAML_VALUE_FORMAT","The visual tree returned a negative child count.");
        return new XamlNodeRecord {Context=context,Path=path,
            Type=DecodeXamlBase64(fields[0]),IdentityHash=hash.ToString(CultureInfo.InvariantCulture),ChildCount=count,
            Name=DecodeXamlBase64(fields[3]),AutomationId=DecodeXamlBase64(fields[4]),
            TextAvailable=fields[5]!="-",Text=fields[5]=="-"?null:DecodeXamlBase64(fields[5])};
    }
    static bool SameXamlNode(XamlNodeRecord first,XamlNodeRecord second){return first.Type==second.Type&&first.Name==second.Name&&first.AutomationId==second.AutomationId&&first.IdentityHash==second.IdentityHash;}
    static object XamlTree(Session s,Dictionary<string,object> r) {
        s.CheckPause(r);CheckCurrentFrame(s,r);
        int timeout=Int(r,"expressionTimeoutMs",1000,100,5000),maxDepth=Int(r,"maxDepth",8,0,16),maxNodes=Int(r,"maxNodes",100,1,500),maxChildren=Int(r,"maxChildren",64,1,128);
        int queryTimeout=Int(r,"queryTimeoutMs",15000,1000,120000);var context=new XamlContext(s);
        context.QueryDeadline=Stopwatch.GetTimestamp()+(long)(queryTimeout*(double)Stopwatch.Frequency/1000);
        try {
            RequireXamlThread(s,context,timeout);
            int[] rootPath=new int[0];string parentRoot=Text(r,"rootNodeId");
            if(parentRoot!=null) {
                XamlNodeRecord observed;
                if(!s.XamlNodes.TryGetValue(parentRoot,out observed))throw Error("STALE_XAML_NODE","The subtree root was not observed in the current XAML snapshot.");
                observed.Context.Check(s);
                if(!SameXamlNode(ReadXamlNode(s,context,observed.Path,timeout),observed))throw Error("STALE_XAML_NODE","The observed subtree root changed. Read the visual tree again.");
                rootPath=(int[])observed.Path.Clone();
            }
            s.InvalidateXamlContext();
            string snapshotId=Guid.NewGuid().ToString();var nodes=new List<object>();var warnings=new List<object>();var queue=new Queue<int[]>();queue.Enqueue(rootPath);bool truncated=false,partial=false;
            while(queue.Count>0&&nodes.Count<maxNodes) {
                int[] path=queue.Dequeue();
                try {
                    var record=ReadXamlNode(s,context,path,timeout);record.SnapshotId=snapshotId;
                    int count=record.ChildCount;s.XamlNodes.Add(record.Id,record);
                    nodes.Add(Map("nodeId",record.Id,"path",path,"relativeDepth",path.Length-rootPath.Length,"type",record.Type,"name",record.Name,"automationId",record.AutomationId,"identityHash",record.IdentityHash,"childCount",count,"text",record.Text,"textAvailable",record.TextAvailable));
                    if(count>0&&path.Length-rootPath.Length>=maxDepth){truncated=true;warnings.Add(Map("path",path,"code","XAML_DEPTH_LIMIT","message","Visual descendants exceed maxDepth relative to the selected root."));}
                    else {int take=Math.Min(count,maxChildren);if(count>take){truncated=true;warnings.Add(Map("path",path,"code","XAML_CHILD_LIMIT","message","Visual children exceed maxChildren."));}for(int i=0;i<take;i++)queue.Enqueue(path.Concat(new[]{i}).ToArray());}
                } catch(Exception error) {
                    if(!IsRecoverableXamlRead(error)||nodes.Count==0)throw;
                    partial=true;warnings.Add(XamlWarning(path,"node",error));
                    if(Convert.ToString(error.Data["code"])=="XAML_QUERY_TIMEOUT"){truncated=true;break;}
                }
            }
            if(queue.Count>0){truncated=true;warnings.Add(Map("code","XAML_NODE_LIMIT","message","Unvisited visual nodes remain within the query limits."));}
            context.Check(s);
            return Map("framework","winrt-xaml","source","debuggee SDK function evaluation","snapshotId",snapshotId,"parentRootNodeId",parentRoot,"rootPath",rootPath,"pauseId",context.PauseId,"uiThreadId",context.NativeThreadId,"nodes",nodes,"truncated",truncated,"partial",partial,"warnings",warnings,"queryTimeoutMs",queryTimeout,"maxNodes",maxNodes,"maxDepth",maxDepth);
        }
        catch{s.InvalidateXamlContext();throw;}
        finally{context.QueryDeadline=0;}
    }
    static bool IsRecoverableXamlRead(Exception error){string code=Convert.ToString(error.Data["code"]);return code=="XAML_EVALUATION_FAILED"||code=="XAML_VALUE_FORMAT"||code=="XAML_QUERY_TIMEOUT";}
    static object XamlWarning(int[] path,string field,Exception error){return Map("path",path,"field",field,"code",Convert.ToString(error.Data["code"]),"message",error.Message);}
    static string XamlPeer(XamlNodeRecord node){return "Windows.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.CreatePeerForElement((Windows.UI.Xaml.UIElement)("+XamlPath(node.Path)+"))";}
    static string XamlPattern(XamlNodeRecord node,string pattern){return XamlPeer(node)+".GetPattern(Windows.UI.Xaml.Automation.Peers.PatternInterface."+pattern+")";}
    static object XamlAction(Session s,Dictionary<string,object> r) {
        s.CheckPause(r);CheckCurrentFrame(s,r);
        XamlNodeRecord node;string id=Text(r,"nodeId");if(id==null||!s.XamlNodes.TryGetValue(id,out node))throw Error("STALE_XAML_NODE","Node ID is unknown or belongs to an expired XAML snapshot. Read the tree again.");
        node.Context.Check(s);int timeout=Int(r,"expressionTimeoutMs",1000,100,5000);RequireXamlThread(s,node.Context,timeout);
        var current=ReadXamlNode(s,node.Context,node.Path,timeout);
        if(!SameXamlNode(current,node)){s.InvalidateXamlContext();throw Error("STALE_XAML_NODE","The visual path now resolves to a different element. Read the tree again.");}
        string action=Text(r,"action"),statement;object expected=null;
        if(action!="invoke"&&action!="setValue"&&action!="setText")throw Error("INVALID_REQUEST","XAML action must be invoke, setValue or setText.");
        string requestedValue=action!="invoke"?Text(r,"value"):null;
        if(action!="invoke"&&(requestedValue==null||requestedValue.Length>4096))throw Error("INVALID_REQUEST","Text actions require text of at most 4096 characters.");
        if(action!="setText"&&!XamlBool(s,node.Context,XamlPeer(node)+" != null",timeout))throw Error("XAML_PATTERN_UNAVAILABLE","The element does not expose an automation peer.");
        if(action=="invoke") {
            if(!XamlBool(s,node.Context,XamlPattern(node,"Invoke")+" != null",timeout))throw Error("XAML_PATTERN_UNAVAILABLE","The element does not expose InvokePattern.");
            statement="((Windows.UI.Xaml.Automation.Provider.IInvokeProvider)("+XamlPattern(node,"Invoke")+")).Invoke();";
        } else if(action=="setValue") {
            string value=requestedValue;
            string pattern=XamlPattern(node,"Value");
            if(!XamlBool(s,node.Context,pattern+" != null",timeout))throw Error("XAML_PATTERN_UNAVAILABLE","The element does not expose ValuePattern.");
            if(XamlBool(s,node.Context,"((Windows.UI.Xaml.Automation.Provider.IValueProvider)("+pattern+")).IsReadOnly",timeout))throw Error("XAML_VALUE_READ_ONLY","The element's ValuePattern is read-only.");
            statement="((Windows.UI.Xaml.Automation.Provider.IValueProvider)("+pattern+")).SetValue("+XamlLiteral(value)+");";expected=value;
        } else {
            if(node.Type!="Windows.UI.Xaml.Controls.TextBox")throw Error("XAML_TEXT_CONTROL_REQUIRED","setText requires an observed standard WinRT XAML TextBox.");
            string box="((Windows.UI.Xaml.Controls.TextBox)("+XamlPath(node.Path)+"))";
            if(XamlBool(s,node.Context,box+".IsReadOnly",timeout))throw Error("XAML_VALUE_READ_ONLY","The TextBox is read-only.");
            if(!XamlBool(s,node.Context,box+".IsEnabled",timeout))throw Error("XAML_CONTROL_DISABLED","The TextBox is disabled.");
            statement=box+".Text = "+XamlLiteral(requestedValue)+";";expected=requestedValue;
        }
        // Function evaluation can mutate the UI or execute arbitrary app event handlers.
        // Retire the snapshot even if statement execution returns an ambiguous failure.
        s.InvalidateXamlContext();node.Context.Check(s);
        if(!SameXamlNode(ReadXamlNode(s,node.Context,node.Path,timeout),node))throw Error("STALE_XAML_NODE","The visual element changed during pattern inspection. Read the tree again.");
        s.Event("xamlActionDispatch",Map("action",action,"nodeId",id,"snapshotId",node.SnapshotId,"pauseId",node.Context.PauseId));
        bool statementReturned=false;
        try {
        s.Dte.Debugger.ExecuteStatement(statement,timeout);statementReturned=true;
        // ExecuteStatement can emit evaluation-complete run/break events and retire
        // the input pause. This is an action result, never a safe-to-replay stale input.
        object observed=null;bool confirmed=false;var warnings=new List<object>();
        if(s.Dte.Debugger.CurrentMode==dbgDebugMode.dbgBreakMode) {
            var after=new XamlContext(s);
            if(after.ProgramKey!=node.Context.ProgramKey||after.NativeThreadId!=node.Context.NativeThreadId)
                warnings.Add(Map("code","XAML_OBSERVATION_CONTEXT_CHANGED","message","The statement returned in a different debugged program or thread; inspect again."));
            else if(action=="setValue"||action=="setText") {
                try {RequireXamlThread(s,after,timeout);if(!SameXamlNode(ReadXamlNode(s,after,node.Path,timeout),node))throw Error("STALE_XAML_NODE","The element changed while handling the text action; read a fresh tree.");string expression=action=="setValue"?"((Windows.UI.Xaml.Automation.Provider.IValueProvider)("+XamlPattern(node,"Value")+")).Value":"((Windows.UI.Xaml.Controls.TextBox)("+XamlPath(node.Path)+")).Text";observed=XamlString(s,after,expression,timeout);confirmed=string.Equals((string)observed,(string)expected,StringComparison.Ordinal);}
                catch(Exception error){warnings.Add(Map("code","XAML_READBACK_UNAVAILABLE","message",error.Message));}
            }
        } else {s.InvalidatePause();warnings.Add(Map("code","XAML_NOT_PAUSED_AFTER_ACTION","message","Inspect the debugger state before requesting another XAML snapshot."));}
        s.Event("xamlActionIssued",Map("action",action,"nodeId",id,"pauseId",s.PauseId,"confirmed",confirmed));
        return Map("issued",true,"action",action,"api",action=="setText"?"Windows.UI.Xaml.Controls.TextBox.Text":action=="setValue"?"ValuePattern.SetValue":"InvokePattern.Invoke","nodeId",id,"snapshotInvalidated",true,"previousPauseId",node.Context.PauseId,"pauseId",s.PauseId,"value",observed,"confirmed",confirmed,"warnings",warnings,"completion",action=="invoke"?"Observe the handler result after resuming execution.":confirmed?"Standard API readback matched.":"Inspect the application to confirm its value.");
        } catch(Exception error) {
            var failure=Error("XAML_ACTION_UNCONFIRMED","The automation statement may have executed. Inspect the debugger and application before issuing another action. "+error.Message);
            failure.Data["operationMayContinue"]=true;
            failure.Data["details"]=Map("issued",statementReturned?(object)true:null,"dispatchStarted",true,"executionResultKnown",false,"action",action,"nodeId",id,"snapshotId",node.SnapshotId,"previousPauseId",node.Context.PauseId,"observedPauseId",s.PauseId,"causeHresult",error.HResult,"requiresInspection",true);
            s.Event("xamlActionUnconfirmed",Map("action",action,"nodeId",id,"message",error.Message));throw failure;
        }
    }
}
