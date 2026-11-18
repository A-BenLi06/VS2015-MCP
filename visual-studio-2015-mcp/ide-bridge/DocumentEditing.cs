using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using EnvDTE;

internal static partial class Program {
    static string HashText(string value) {
        using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();
    }
    sealed class RangeEdit {
        public int Start,End,StartLine,StartColumn,EndLine,EndColumn;public string Text;
    }
    static int TextPosition(string content,int line,int column) {
        int current=1,start=0;
        for(int i=0;i<content.Length&&current<line;i++) {
            if(content[i]=='\r'||content[i]=='\n') {if(content[i]=='\r'&&i+1<content.Length&&content[i+1]=='\n')i++;start=i+1;current++;}
        }
        if(current!=line)throw Error("EDIT_RANGE_INVALID","The edit line is outside the current buffer.");
        int end=start;while(end<content.Length&&content[end]!='\r'&&content[end]!='\n')end++;
        if(column<1||column>end-start+1)throw Error("EDIT_RANGE_INVALID","The edit column is outside the current line (UTF-16 character offsets).");
        return start+column-1;
    }
    static Dictionary<string,object> PositionObject(Dictionary<string,object> edit,string field) {
        object raw;Dictionary<string,object> result;
        if(!edit.TryGetValue(field,out raw)||(result=raw as Dictionary<string,object>)==null)throw Error("EDIT_RANGE_INVALID","Each edit needs start and end line/column objects.");return result;
    }
    static object ApplyDocumentEdits(Session session,Dictionary<string,object> request) {
        RequireDesign(session);Document document=FindDocument(session,Text(request,"path"));if(document.ReadOnly)throw Error("READ_ONLY_DOCUMENT","The selected document is read-only.");
        var buffer=document.Object("TextDocument") as TextDocument;if(buffer==null)throw Error("NOT_TEXT_DOCUMENT","The selected document has no text buffer.");
        string before=ReadText(buffer),beforeHash=HashText(before);if(before.Length>1048576)throw Error("DOCUMENT_TOO_LARGE","Range editing is limited to one Mi UTF-16 characters.");
        if(!string.Equals(Text(request,"expectedSha256"),beforeHash,StringComparison.OrdinalIgnoreCase))throw Error("DOCUMENT_CONFLICT","The IDE text hash changed; re-read the document before editing.");
        object raw;if(!request.TryGetValue("edits",out raw)||!(raw is IEnumerable)||raw is string)throw Error("INVALID_REQUEST","edits must be an array.");
        var edits=new List<RangeEdit>();
        foreach(object value in (IEnumerable)raw) {
            if(edits.Count>=100)throw Error("INVALID_REQUEST","At most 100 edits may be applied in one transaction.");
            var item=value as Dictionary<string,object>;if(item==null)throw Error("INVALID_REQUEST","Each edit must be an object.");
            var start=PositionObject(item,"start");var end=PositionObject(item,"end");
            var edit=new RangeEdit{StartLine=Int(start,"line",0,1,int.MaxValue),StartColumn=Int(start,"column",0,1,int.MaxValue),EndLine=Int(end,"line",0,1,int.MaxValue),EndColumn=Int(end,"column",0,1,int.MaxValue),Text=Text(item,"text")};
            if(edit.Text==null||edit.Text.Length>1048576)throw Error("INVALID_REQUEST","Each edit requires bounded replacement text.");
            edit.Start=TextPosition(before,edit.StartLine,edit.StartColumn);edit.End=TextPosition(before,edit.EndLine,edit.EndColumn);
            if(edit.End<edit.Start)throw Error("EDIT_RANGE_INVALID","Edit end precedes its start.");
            string expected=Text(item,"expectedText");if(expected!=null&&before.Substring(edit.Start,edit.End-edit.Start)!=expected)throw Error("EDIT_TEXT_CONFLICT","The selected range differs from expectedText.");edits.Add(edit);
        }
        if(edits.Count==0)throw Error("INVALID_REQUEST","At least one edit is required.");
        edits=edits.OrderBy(edit=>edit.Start).ThenBy(edit=>edit.End).ToList();
        for(int i=1;i<edits.Count;i++)if(edits[i].Start<edits[i-1].End||edits[i].Start==edits[i-1].Start)throw Error("EDIT_RANGES_OVERLAP","Edit ranges must not overlap or share an insertion point.");
        var expectedBuffer=new StringBuilder(before);foreach(var edit in edits.AsEnumerable().Reverse()){expectedBuffer.Remove(edit.Start,edit.End-edit.Start);expectedBuffer.Insert(edit.Start,edit.Text);}
        if(expectedBuffer.Length>1048576)throw Error("DOCUMENT_TOO_LARGE","The edited document exceeds the range-editing limit.");
        var undo=session.Dte.UndoContext;if(undo.IsOpen)throw Error("UNDO_CONTEXT_BUSY","Another editor transaction is open; it will not be joined or aborted.");
        bool opened=false;
        try {
            undo.Open("MCP document edits",false);opened=true;
            foreach(var edit in edits.AsEnumerable().Reverse()) {
                var start=buffer.StartPoint.CreateEditPoint();var end=buffer.StartPoint.CreateEditPoint();start.MoveToLineAndOffset(edit.StartLine,edit.StartColumn);end.MoveToLineAndOffset(edit.EndLine,edit.EndColumn);
                start.ReplaceText(end,edit.Text,(int)vsEPReplaceTextOptions.vsEPReplaceTextKeepMarkers);
            }
            if(ReadText(buffer)!=expectedBuffer.ToString())throw Error("EDIT_VERIFY_FAILED","The editor returned text different from the requested edit transaction.");
            undo.Close();opened=false;
        } catch(Exception error) {
            if(opened){try{undo.SetAborted();undo.Close();if(ReadText(buffer)!=before)throw new InvalidOperationException("The restored text differs from the pre-edit buffer.");}catch(Exception rollback){throw Error("EDIT_ROLLBACK_FAILED",error.Message+" Rollback: "+rollback.Message);}}
            throw;
        }
        if(Bool(request,"save"))document.Save("");
        return Map("path",document.FullName,"editCount",edits.Count,"beforeSha256",beforeHash,"sha256",HashText(ReadText(buffer)),"saved",document.Saved);
    }
}
