using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Xml;
using EnvDTE;

internal static partial class Program {
    const int MaximumAppManifestBytes=4*1024*1024;
    const string Appx2010Namespace="http://schemas.microsoft.com/appx/2010/manifest";
    const string AppxWindows10Namespace="http://schemas.microsoft.com/appx/manifest/foundation/windows10";
    const string Phone2014Namespace="http://schemas.microsoft.com/appx/2014/phone/manifest";

    sealed class AppManifestInventory {
        public readonly HashSet<long> SeenItems=new HashSet<long>();
        public readonly List<ProjectItem> RetainedItems=new List<ProjectItem>();
        public readonly HashSet<string> Paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public int Items;
    }
    static bool FullyQualifiedManifestPath(string value) {
        return !string.IsNullOrEmpty(value)&&((value.Length>=3&&char.IsLetter(value[0])&&value[1]==':'&&(value[2]=='\\'||value[2]=='/'))||value.StartsWith(@"\\",StringComparison.Ordinal));
    }
    static void CollectAppManifests(ProjectItems items,int depth,AppManifestInventory inventory) {
        if(items==null)return;
        if(depth>32)throw Error("APP_MANIFEST_INVENTORY_LIMIT","Project item nesting exceeded32 levels; identity discovery is incomplete.");
        foreach(ProjectItem item in items) {
            if(!inventory.SeenItems.Add(ComIdentity(item)))continue;
            inventory.RetainedItems.Add(item);
            if(++inventory.Items>10000)throw Error("APP_MANIFEST_INVENTORY_LIMIT","Project identity discovery exceeded10000 included items.");
            short count=item.FileCount;
            if(count>64)throw Error("APP_MANIFEST_INVENTORY_LIMIT","A project item exposes more than64 files.");
            for(short index=1;index<=count;index++) {
                string file=item.get_FileNames(index);
                if(!string.Equals(Path.GetExtension(file),".appxmanifest",StringComparison.OrdinalIgnoreCase))continue;
                if(!FullyQualifiedManifestPath(file))throw Error("APP_MANIFEST_ITEM_PATH","The project returned a manifest path that is not fully qualified.");
                inventory.Paths.Add(Path.GetFullPath(file));
                if(inventory.Paths.Count>256)throw Error("APP_MANIFEST_INVENTORY_LIMIT","The project exposes more than256 manifest files.");
            }
            // Do not include a referenced or nested project's items as if they
            // belonged to this explicitly selected project.
            if(item.SubProject==null)CollectAppManifests(item.ProjectItems,depth+1,inventory);
        }
    }
    static void EnsureSavedManifest(Session session,string manifestPath) {
        int count=0;
        foreach(Document document in session.Dte.Documents) {
            if(++count>2000)throw Error("APP_MANIFEST_DOCUMENT_LIMIT","Open-document inventory exceeded2000 entries; saved manifest state cannot be confirmed.");
            string path=document.FullName;
            if(!FullyQualifiedManifestPath(path))continue;
            if(string.Equals(Path.GetFullPath(path),manifestPath,StringComparison.OrdinalIgnoreCase)&&!document.Saved)
                throw Error("APP_MANIFEST_UNSAVED","The included manifest has unsaved IDE edits. Save it before binding an application identity: "+manifestPath);
        }
    }
    static XmlElement[] ManifestChildren(XmlElement parent,string localName,string ns) {
        var result=new List<XmlElement>();
        foreach(XmlNode child in parent.ChildNodes){var element=child as XmlElement;if(element!=null&&element.LocalName==localName&&element.NamespaceURI==ns)result.Add(element);}
        return result.ToArray();
    }
    static XmlElement SingleManifestChild(XmlElement parent,string localName,string ns,bool required) {
        var found=ManifestChildren(parent,localName,ns);
        if(found.Length>1||(required&&found.Length!=1))throw Error("APP_MANIFEST_INVALID","Expected "+(required?"exactly one":"at most one")+" schema-qualified "+localName+" element.");
        return found.Length==0?null:found[0];
    }
    static string ManifestAttribute(XmlElement element,string name,bool required) {
        if(!element.HasAttribute(name)){if(required)throw Error("APP_MANIFEST_INVALID","Required manifest attribute is missing: "+element.LocalName+"/@"+name);return null;}
        string value=element.GetAttribute(name);
        if(required&&string.IsNullOrWhiteSpace(value))throw Error("APP_MANIFEST_INVALID","Required manifest attribute is empty: "+element.LocalName+"/@"+name);
        return value;
    }
    static Dictionary<string,object> ParseAppxIdentity(byte[] bytes) {
        if(bytes==null||bytes.Length==0||bytes.Length>MaximumAppManifestBytes)throw Error("APP_MANIFEST_SIZE","An app manifest must contain1..4194304 bytes.");
        var settings=new XmlReaderSettings {DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=MaximumAppManifestBytes,MaxCharactersFromEntities=0};
        var document=new XmlDocument {XmlResolver=null,PreserveWhitespace=true};
        try{using(var memory=new MemoryStream(bytes,false))using(var reader=XmlReader.Create(memory,settings))document.Load(reader);}
        catch(XmlException error){throw Error("APP_MANIFEST_XML_INVALID",error.Message);}
        var root=document.DocumentElement;
        if(root==null||root.LocalName!="Package"||(root.NamespaceURI!=Appx2010Namespace&&root.NamespaceURI!=AppxWindows10Namespace))throw Error("APP_MANIFEST_SCHEMA_UNSUPPORTED","Expected a Package in the Appx2010 or Windows10 foundation namespace.");
        string ns=root.NamespaceURI;
        var identity=SingleManifestChild(root,"Identity",ns,true);
        var package=Map("name",ManifestAttribute(identity,"Name",true),"publisher",ManifestAttribute(identity,"Publisher",true),"version",ManifestAttribute(identity,"Version",true),"processorArchitecture",ManifestAttribute(identity,"ProcessorArchitecture",false),"resourceId",ManifestAttribute(identity,"ResourceId",false));
        var phone=SingleManifestChild(root,"PhoneIdentity",Phone2014Namespace,false);
        Dictionary<string,object> phoneIdentity=null;
        if(phone!=null) {
            string product=ManifestAttribute(phone,"PhoneProductId",true),publisher=ManifestAttribute(phone,"PhonePublisherId",true);Guid parsed;
            if(!Guid.TryParse(product,out parsed)||!Guid.TryParse(publisher,out parsed))throw Error("APP_MANIFEST_INVALID","Phone identity attributes must be actual GUID values.");
            phoneIdentity=Map("namespace",phone.NamespaceURI,"phoneProductId",product,"phonePublisherId",publisher);
        }
        var applications=new List<object>();var ids=new HashSet<string>(StringComparer.Ordinal);
        var container=SingleManifestChild(root,"Applications",ns,false);
        if(container!=null)foreach(var application in ManifestChildren(container,"Application",ns)) {
            if(applications.Count>=256)throw Error("APP_MANIFEST_INVALID","The manifest contains more than256 applications.");
            string id=ManifestAttribute(application,"Id",true);
            if(!ids.Add(id))throw Error("APP_MANIFEST_INVALID","The manifest contains duplicate application IDs.");
            applications.Add(Map("id",id,"namespace",application.NamespaceURI,"executable",ManifestAttribute(application,"Executable",false),"entryPoint",ManifestAttribute(application,"EntryPoint",false),"startPage",ManifestAttribute(application,"StartPage",false)));
        }
        var namespaces=new List<object>();
        foreach(XmlAttribute attribute in root.Attributes)if(attribute.NamespaceURI=="http://www.w3.org/2000/xmlns/")namespaces.Add(Map("prefix",attribute.Prefix=="xmlns"?attribute.LocalName:"","namespaceUri",attribute.Value));
        using(var sha=SHA256.Create())return Map("manifestNamespace",ns,"namespaceDeclarations",namespaces,"packageIdentity",package,"phoneIdentity",phoneIdentity,"applications",applications,"manifestSha256",BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(),"manifestBytes",bytes.Length);
    }
    static Dictionary<string,object> ReadAppxIdentityFile(string path) {
        try {
            // Read one byte snapshot while denying write/delete sharing. Hash
            // and parsed identity therefore describe the same source content.
            using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                if(stream.Length<1||stream.Length>MaximumAppManifestBytes)throw Error("APP_MANIFEST_SIZE","An app manifest must contain1..4194304 bytes.");
                var bytes=new byte[(int)stream.Length];int position=0;
                while(position<bytes.Length){int read=stream.Read(bytes,position,bytes.Length-position);if(read==0)throw Error("APP_MANIFEST_READ_FAILED","Manifest ended before its complete byte snapshot was read.");position+=read;}
                var result=ParseAppxIdentity(bytes);result["lastWriteTimeUtc"]=File.GetLastWriteTimeUtc(path).ToString("o");return result;
            }
        }catch(FileNotFoundException){throw Error("APP_MANIFEST_NOT_FOUND","The included manifest does not exist on disk: "+path);}
        catch(DirectoryNotFoundException){throw Error("APP_MANIFEST_NOT_FOUND","The included manifest directory does not exist: "+path);}
    }
    static object ProjectAppIdentity(Session session,Dictionary<string,object> request) {
        string before=ConfigurationToken(session);
        var project=SelectProject(session,Text(request,"projectUniqueName"));
        var inventory=new AppManifestInventory();
        try{CollectAppManifests(project.ProjectItems,0,inventory);}
        catch(COMException error){throw Error("APP_MANIFEST_INVENTORY_FAILED","Included project manifest discovery failed: "+error.Message);}
        var paths=inventory.Paths.OrderBy(value=>value,StringComparer.OrdinalIgnoreCase).ToArray();
        if(paths.Length==0)throw Error("APP_MANIFEST_NOT_INCLUDED","The selected project exposes no included .appxmanifest file.");
        string selected=Text(request,"manifestPath");
        if(selected!=null) {
            if(!FullyQualifiedManifestPath(selected))throw Error("INVALID_REQUEST","manifestPath must be a fully qualified path to an included project item.");
            selected=Path.GetFullPath(selected);
            if(!inventory.Paths.Contains(selected))throw Error("APP_MANIFEST_NOT_INCLUDED","The requested manifestPath is not included in the selected project.");
        } else {
            if(paths.Length!=1)throw Error("APP_MANIFEST_AMBIGUOUS","The selected project contains multiple manifests; pass an exact included manifestPath: "+string.Join("; ",paths.Take(12)));
            selected=paths[0];
        }
        EnsureSavedManifest(session,selected);
        var result=ReadAppxIdentityFile(selected);
        EnsureSavedManifest(session,selected);
        if(before!=ConfigurationToken(session))throw Error("CONFIGURATION_CONFLICT","The active IDE configuration changed while reading the application identity.");
        result["sessionId"]=session.Id;result["ideProcessId"]=session.ProcessId;result["ideStartTimeUtc"]=session.StartUtc;result["ideLocaleId"]=session.Dte.LocaleID;
        result["solutionPath"]=session.Dte.Solution.FullName;result["projectUniqueName"]=project.UniqueName;result["projectPath"]=project.FullName;
        result["manifestPath"]=selected;result["manifestCandidates"]=paths;result["configurationToken"]=before;result["source"]="included-project-item-saved-disk";
        return result;
    }
}
