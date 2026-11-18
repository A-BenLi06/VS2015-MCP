using System;
using System.Text;
using System.Globalization;
internal static partial class Program {
    static string DecodeDebuggerStringLiteral(string value) {
        if(value=="null")return null;
        if(value==null)throw Error("DEBUGGER_LITERAL_FORMAT","The debugger returned no string value.");
        if(value.Length>=3&&value.StartsWith("@\"",StringComparison.Ordinal)&&value[value.Length-1]=='"') {
            var text=new StringBuilder();for(int i=2;i<value.Length-1;i++){char c=value[i];if(c=='"'){if(i+1>=value.Length-1||value[++i]!='"')throw Error("DEBUGGER_LITERAL_FORMAT","Invalid verbatim debugger string.");}text.Append(c);}return text.ToString();
        }
        if(value.Length<2||value[0]!='"'||value[value.Length-1]!='"')throw Error("DEBUGGER_LITERAL_FORMAT","The debugger did not return a complete quoted string.");
        var result=new StringBuilder();
        for(int i=1;i<value.Length-1;i++) {
            char c=value[i];
            if(c=='"'||c<' ')throw Error("DEBUGGER_LITERAL_FORMAT","Invalid character in debugger string literal.");
            if(c!='\\'){result.Append(c);continue;}
            if(++i>=value.Length-1)throw Error("DEBUGGER_LITERAL_FORMAT","Unterminated debugger escape.");
            c=value[i];
            switch(c) {
                case '\\':result.Append('\\');break;case '"':result.Append('"');break;case '\'':result.Append('\'');break;
                case '0':result.Append('\0');break;case 'a':result.Append('\a');break;case 'b':result.Append('\b');break;
                case 'f':result.Append('\f');break;case 'n':result.Append('\n');break;case 'r':result.Append('\r');break;
                case 't':result.Append('\t');break;case 'v':result.Append('\v');break;
                case 'u':case 'U':case 'x': {
                    int minimum=c=='x'?1:c=='u'?4:8,maximum=c=='x'?4:minimum,digits=0;uint scalar=0;
                    while(digits<maximum&&i+1<value.Length-1) {
                        char next=value[i+1];int digit=next>='0'&&next<='9'?next-'0':next>='a'&&next<='f'?next-'a'+10:next>='A'&&next<='F'?next-'A'+10:-1;
                        if(digit<0)break;scalar=scalar*16+(uint)digit;i++;digits++;
                    }
                    if(digits<minimum||scalar>0x10ffff)throw Error("DEBUGGER_LITERAL_FORMAT","Invalid Unicode debugger escape.");
                    if(c=='U'&&scalar>=0xd800&&scalar<=0xdfff)throw Error("DEBUGGER_LITERAL_FORMAT","Invalid Unicode scalar.");
                    if(scalar<=0xffff)result.Append((char)scalar);else result.Append(char.ConvertFromUtf32((int)scalar));break;
                }
                default:throw Error("DEBUGGER_LITERAL_FORMAT","Unsupported debugger string escape.");
            }
        }
        return result.ToString();
    }
    static string EncodeDebuggerStringLiteral(string value) {
        var result=new StringBuilder("\"");foreach(char c in value){if(c=='\\')result.Append("\\\\");else if(c=='"')result.Append("\\\"");else if(c<' '||c=='\u2028'||c=='\u2029')result.Append("\\u"+((int)c).ToString("x4",CultureInfo.InvariantCulture));else result.Append(c);}return result.Append('"').ToString();
    }
}
