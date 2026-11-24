import adsk.core, adsk.fusion, json, struct, array, os, re, time
# Set to the workspace containing work/ before running inside Fusion.
BASE=os.environ.get('STORMTROOPER_EXPORT_ROOT')
if not BASE: raise RuntimeError('Set STORMTROOPER_EXPORT_ROOT before exporting CAD')
# Export raw meshes outside the live application; optimize them before replacement.
OUT=BASE+'/work/cad-export'

def run(_context: str):
    app=adsk.core.Application.get()
    design=adsk.fusion.Design.cast(app.activeProduct)
    assert app.activeDocument.name=='VORON 2.4 Toolchanger 6 Head'
    os.makedirs(OUT,exist_ok=True)
    cache={}; material_cache={}; chunks={}; counts={'bodies':0,'triangles':0,'occurrences':0,'skipped':0}; started=time.time()
    report=open(BASE+'/work/export-progress.txt','w')
    def log(s): report.write(str(s)+'\n');report.flush()
    def color_of(body):
        appearance=body.appearance
        if not appearance:return (0.45,0.48,0.5,1)
        key=appearance.id
        if key in material_cache:return material_cache[key]
        col=None
        for prop_id in ['opaque_albedo','metal_f0','generic_diffuse','transparent_color','glazing_transmittance']:
            p=appearance.appearanceProperties.itemById(prop_id)
            if p and isinstance(p,adsk.core.ColorProperty) and p.value:
                v=p.value;col=(v.red/255,v.green/255,v.blue/255,1);break
        if not col:
            for p in appearance.appearanceProperties:
                if isinstance(p,adsk.core.ColorProperty) and p.value:
                    v=p.value;col=(v.red/255,v.green/255,v.blue/255,1);break
        if not col:col=(.45,.48,.5,1)
        if any(k in appearance.name.lower() for k in ['glass','clear','transparent','acryl','polycarbon','glazing']):col=(.45,.57,.6,.12)
        material_cache[key]=col
        return col
    def add_body(body,matrix,tool_id,path):
        if not body.isVisible:return
        native=body.nativeObject or body
        key=native.entityToken
        if key not in cache:
            calc=native.meshManager.createMeshCalculator()
            calc.setQuality(adsk.fusion.TriangleMeshQualityOptions.LowQualityTriangleMesh)
            calc.surfaceTolerance=0.035
            mesh=calc.calculate()
            if not mesh:return
            coords=list(mesh.nodeCoordinatesAsFloat);normals=list(mesh.normalVectorsAsFloat);indices=list(mesh.nodeIndices)
            cache[key]=(coords,normals,indices)
        coords,normals,indices=cache[key]
        if not coords or not indices:return
        color=color_of(body)
        batch=chunks.setdefault((tool_id,color),{'p':array.array('f'),'n':array.array('f'),'i':array.array('I')})
        offset=len(batch['p'])//3
        m=matrix
        for i in range(0,len(coords),3):
            x,y,z=coords[i:i+3]
            batch['p'].extend(((m[0]*x+m[1]*y+m[2]*z+m[3])*.01,(m[4]*x+m[5]*y+m[6]*z+m[7])*.01,(m[8]*x+m[9]*y+m[10]*z+m[11])*.01))
            nx,ny,nz=normals[i:i+3]
            batch['n'].extend((m[0]*nx+m[1]*ny+m[2]*nz,m[4]*nx+m[5]*ny+m[6]*nz,m[8]*nx+m[9]*ny+m[10]*nz))
        batch['i'].extend(v+offset for v in indices)
        counts['bodies']+=1;counts['triangles']+=len(indices)//3
    # Root allOccurrences supplies transforms in the root assembly context.
    occurrences=design.rootComponent.allOccurrences
    total=occurrences.count
    log({'start':total})
    for index in range(total):
        occ=occurrences.item(index)
        if not occ.isVisible:continue
        name=occ.name
        if re.search(r'(screw|washer|nut\b|schraube|mutter|DIN\d|ISO ?\d)',name,re.I):counts['skipped']+=1;continue
        if not occ.component.bRepBodies.count:continue
        path=occ.fullPathName
        tool_id=-1
        if '+Atom Toolchanger Unibody v65:1+' in path:
            segment=path.split('+Atom Toolchanger Unibody v65:1+')[1].split('+')[0]
            suffix=re.search(r'Magnet(?: \((\d)\))?:',segment)
            if suffix:tool_id={None:3,'4':1,'3':2,'1':4,'2':5}.get(suffix.group(1),-1)
        elif '+Atom TC StealthChanger Unibody:1+Toolhead (3) (1):1' in path:tool_id=0
        matrix=occ.transform2.asArray()
        for body in occ.bRepBodies:add_body(body,matrix,tool_id,path)
        counts['occurrences']+=1
        if counts['occurrences']%30==0:log({'index':index,**counts,'seconds':round(time.time()-started)})
    def glb(batches,filename):
        doc={'asset':{'version':'2.0','generator':'Fusion MCP CAD mesh export'},'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':[],'buffers':[],'bufferViews':[],'accessors':[]}
        data=bytearray()
        def accessor(values,ctype,kind,target,position=False):
            while len(data)%4:data.append(0)
            raw=values.tobytes();view=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':len(data),'byteLength':len(raw),'target':target});data.extend(raw)
            row={'bufferView':view,'componentType':ctype,'count':len(values)//(3 if kind=='VEC3' else 1),'type':kind}
            if position:row.update({'min':[min(values[a::3]) for a in range(3)],'max':[max(values[a::3]) for a in range(3)]})
            idx=len(doc['accessors']);doc['accessors'].append(row);return idx
        for (tid,col),batch in batches.items():
            if not batch['i']:continue
            mat=len(doc['materials']);linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in col[:3]]
            material={'name':'CAD appearance','pbrMetallicRoughness':{'baseColorFactor':linear+[col[3]],'metallicFactor':.12,'roughnessFactor':.65},'doubleSided':True}
            if col[3]<1:material['alphaMode']='BLEND'
            doc['materials'].append(material)
            prim={'attributes':{'POSITION':accessor(batch['p'],5126,'VEC3',34962,True),'NORMAL':accessor(batch['n'],5126,'VEC3',34962)},'indices':accessor(batch['i'],5125,'SCALAR',34963),'material':mat}
            mi=len(doc['meshes']);doc['meshes'].append({'primitives':[prim]})
            node={'name':'Tool T'+str(tid) if tid>=0 else 'Printer CAD','mesh':mi}
            if tid>=0:node['extras']={'toolId':tid}
            ni=len(doc['nodes']);doc['nodes'].append(node);doc['scenes'][0]['nodes'].append(ni)
        doc['buffers']=[{'byteLength':len(data)}]
        j=json.dumps(doc,separators=(',',':')).encode();j+=b' '*((-len(j))%4);data+=b'\0'*((-len(data))%4)
        with open(OUT+'/'+filename,'wb') as f:f.write(struct.pack('<III',0x46546c67,2,12+8+len(j)+8+len(data)));f.write(struct.pack('<II',len(j),0x4e4f534a));f.write(j);f.write(struct.pack('<II',len(data),0x004e4942));f.write(data)
        log({'file':filename,'bytes':os.path.getsize(OUT+'/'+filename),'meshes':len(doc['meshes'])})
    glb(chunks,'printer.glb')
    # Tools are an inspection lineup; model coordinates are deliberately not live positions.
    tool_chunks={}
    source_ids=sorted(set(tid for tid,col in chunks if tid>=0))
    for tid in range(6):
        source=tid if tid in source_ids else source_ids[0]
        relevant=[(col,b) for (sid,col),b in chunks.items() if sid==source]
        lo=[min(min(b['p'][axis::3]) for col,b in relevant) for axis in range(3)]
        hi=[max(max(b['p'][axis::3]) for col,b in relevant) for axis in range(3)]
        center=[(lo[a]+hi[a])/2 for a in range(3)]
        for col,b in relevant:
            p=array.array('f',b['p'])
            for i in range(0,len(p),3):p[i]=p[i]-center[0]+(tid-2.5)*.095;p[i+1]-=lo[1];p[i+2]-=center[2]
            tool_chunks[(tid,col)]={'p':p,'n':b['n'],'i':b['i']}
        log({'tool':tid,'source':source,'bounds':[lo,hi]})
    glb(tool_chunks,'tools.glb')
    metadata={'sourceDocument':app.activeDocument.name,'exportedAt':time.strftime('%Y-%m-%dT%H:%M:%S'),'counts':counts,'sourceToolIds':source_ids,'notes':['Older docks without KNOMI and older toolhead shuttle, confirmed by owner.','Tool lineup rearranged for selection; CAD positions are not live.','Small named screws, washers and nuts omitted.'],'surfaceToleranceCm':.035}
    with open(OUT+'/provenance.json','w') as f:json.dump(metadata,f,indent=2)
    log({'finished':round(time.time()-started)})
    report.close()
    print(json.dumps(metadata))
