import adsk.core,adsk.fusion,json,re,ast,os
# Set to the workspace containing work/ before running inside Fusion.
BASE=os.environ.get('DOCKYARD_EXPORT_ROOT') or os.environ.get('STORMTROOPER_EXPORT_ROOT')
if not BASE: raise RuntimeError('Set DOCKYARD_EXPORT_ROOT before exporting CAD')
def run(_context: str):
    app=adsk.core.Application.get()
    doc=next(d for d in app.documents if d.name=='VORON 2.4 Toolchanger 6 Head')
    design=adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    bounds={}
    for line in open(BASE+'/work/export-progress.txt'):
        row=ast.literal_eval(line)
        if 'tool' in row:bounds[row['tool']]=row['bounds']
    parts=[]
    for o in design.rootComponent.allOccurrences:
        if not ('Toolhead Number Logo' in o.name or 'Grill Shell Sequin RGB' in o.name) or not o.isVisible:continue
        path=o.fullPathName;old=-1
        if '+Atom Toolchanger Unibody v65:1+' in path:
            segment=path.split('+Atom Toolchanger Unibody v65:1+')[1].split('+')[0]
            m=re.search(r'Magnet(?: \((\d)\))?:',segment)
            if m:old={None:2,'4':0,'3':1,'1':3,'2':4}.get(m.group(1),-1)
        elif '+Atom TC StealthChanger Unibody:1+Toolhead (3) (1):1' in path:old=5
        if old<0:continue
        tid=(old+1)%6;matrix=o.transform2.asArray()
        for body in o.bRepBodies:
            if not body.isVisible:continue
            role='number' if body.name==str(tid) and 'Number Logo' in o.name else 'led' if body.name.startswith('RGB LED Dummy') else None
            if not role:continue
            native=body.nativeObject or body
            targets=[]
            if role=='number':
                targets.append(('numberBase',native,.0008))
                for face in native.faces:
                    if not face.appearance or '255,255,255' not in face.appearance.name:continue
                    mesh=face.meshManager.createMeshCalculator().calculate();nx,ny,nz=mesh.normalVectorsAsFloat[:3];m=matrix
                    normal=[m[0]*nx+m[1]*ny+m[2]*nz,m[4]*nx+m[5]*ny+m[6]*nz,m[8]*nx+m[9]*ny+m[10]*nz]
                    width=face.boundingBox.maxPoint.x-face.boundingBox.minPoint.x
                    if abs(normal[0])<.01 and abs(normal[1]-.707107)<.01 and abs(normal[2]-.707107)<.01 and width<1.3 and face.area>.1:
                        targets.append(('number',face,.001))
            else:
                targets += [('led',face,.00008) for face in native.faces if face.appearance and face.appearance.name.startswith('LED -')]
            for part_role,target,push in targets:
                calc=target.meshManager.createMeshCalculator();calc.setQuality(adsk.fusion.TriangleMeshQualityOptions.NormalQualityTriangleMesh);mesh=calc.calculate()
                xyz=mesh.nodeCoordinatesAsFloat;normals=mesh.normalVectorsAsFloat;p=[];n=[];m=matrix
                for i in range(0,len(xyz),3):
                    x,y,z=xyz[i:i+3];nx,ny,nz=normals[i:i+3]
                    normal=[m[0]*nx+m[1]*ny+m[2]*nz,m[4]*nx+m[5]*ny+m[6]*nz,m[8]*nx+m[9]*ny+m[10]*nz]
                    pos=[(m[0]*x+m[1]*y+m[2]*z+m[3])*.01,(m[4]*x+m[5]*y+m[6]*z+m[7])*.01,(m[8]*x+m[9]*y+m[10]*z+m[11])*.01]
                    p.extend(round(pos[a]+normal[a]*push,7) for a in range(3));n.extend(round(v,6) for v in normal)
                lo,hi=bounds[old];offset=[(tid-2.5)*.095-(lo[0]+hi[0])/2,-lo[1],-(lo[2]+hi[2])/2]
                parts.append({'toolId':tid,'role':part_role,'sourceBody':body.name,'sourceAppearance':target.appearance.name,'position':p,'normal':n,'index':list(mesh.nodeIndices),'lineupOffset':offset})
    with open(BASE+'/outputs/stormtrooper-ui/public/models/lights.json','w') as f:json.dump({'source':doc.name,'parts':parts},f,separators=(',',':'))
    print(json.dumps([{'toolId':p['toolId'],'role':p['role'],'vertices':len(p['position'])//3} for p in parts]))
