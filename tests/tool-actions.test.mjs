import test from 'node:test'
import assert from 'node:assert/strict'
import { commandFor, capabilities } from '../server/control.mjs'
import { normalizeStatus } from '../server/status.mjs'
import { toolActionReason } from '../src/tool-action-state.mjs'
const state = () => {
 const config = Object.fromEntries(['park_toolhead','pickup_tool','clean_nozzle','purge_nozzle','load_filament','unload_filament','unload_all','_load_settings','_unload_settings','_goto_purge_pos','_purge_pos'].map(name => [`gcode_macro ${name}`,{gcode:'installed'}]))
 config['gcode_macro _load_settings'].variable_temp_default='240'
 const raw={'gcode_macro _LOAD_SETTINGS':{temp_default:240},'gcode_macro _UNLOAD_SETTINGS':{temp_default:235},webhooks:{state:'ready'},print_stats:{state:'standby'},idle_timeout:{state:'Idle'},toolhead:{homed_axes:'xyz',position:[100,100,20,0]},toolchanger:{has_detection:true,tool_number:1,detected_tool_number:1,status:'ready'},configfile:{settings:config}}
 for(let i=0;i<6;i++) { config[`gcode_macro t${i}`]={};config[`tool t${i}`]={};config[i?`extruder${i}`:'extruder']={max_temp:300,min_extrude_temp:170};raw[`filament_switch_sensor T${i}_filament_sensor`]={enabled:true,filament_detected:true} }
 config['fan_generic fan0']={max_power:.72};config['fan_generic bedfans']={max_power:1};raw['fan_generic BedFans']={};raw['fan_generic fan0']={};config['heater_fan t0_hotend_fan']={}
 return raw
}
test('park applies only to mounted tool; pickup requires empty shuttle and permitted Z',()=>{
 const raw=state()
 assert.equal(commandFor({action:'park',tool:1},raw).body.script,'PARK_TOOLHEAD\nM400')
 assert.throws(()=>commandFor({action:'park',tool:0},raw),/aufgenommene/)
 assert.throws(()=>commandFor({action:'pickup',tool:0},raw),/parken/)
 raw.toolchanger.tool_number=-1;raw.toolchanger.detected_tool_number=-1
 assert.equal(commandFor({action:'pickup',tool:0},raw).body.script,'PICKUP_TOOL T=0\nM400')
 raw.toolhead.position[2]=310;assert.throws(()=>commandFor({action:'pickup',tool:0},raw),/300 mm/)
})
test('single-tool maintenance uses installed macros, selects correctly, and preserves macro defaults',()=>{
 const raw=state()
 assert.equal(commandFor({action:'clean',tool:1},raw).body.script,'CLEAN_NOZZLE\nM400')
 assert.equal(commandFor({action:'clean',tool:2},raw).body.script,'T2\nM400\nCLEAN_NOZZLE\nM400')
 assert.equal(commandFor({action:'purge',tool:2},raw).body.script,'T2\nM400\nPURGE_NOZZLE\nM400')
 assert.equal(commandFor({action:'load',tool:2},raw).body.script,'LOAD_FILAMENT T=2\nM400')
 raw.toolchanger.tool_number=-1;raw.toolchanger.detected_tool_number=-1
 assert.match(commandFor({action:'unload',tool:2},raw).body.script,/^PICKUP_TOOL T=2\nM400\nUNLOAD_FILAMENT T=2/)
})
test('bulk filament is sequential and includes only enabled positive sensors',()=>{
 const raw=state();raw['filament_switch_sensor T0_filament_sensor'].filament_detected=false;raw['filament_switch_sensor T2_filament_sensor'].enabled=false;delete raw['filament_switch_sensor T3_filament_sensor']
 const script=commandFor({action:'load_all'},raw).body.script
 assert.equal(script,'LOAD_FILAMENT T=1\nLOAD_FILAMENT T=4\nLOAD_FILAMENT T=5\nM400')
 assert.equal(commandFor({action:'unload_all'},raw).body.script,'UNLOAD_FILAMENT T=1\nUNLOAD_FILAMENT T=4\nUNLOAD_FILAMENT T=5\nPARK_TOOLHEAD\nM400')
 for(let i=0;i<6;i++)raw[`filament_switch_sensor T${i}_filament_sensor`]={enabled:true,filament_detected:false}
 assert.throws(()=>commandFor({action:'load_all'},raw),/Kein aktivierter/)
})
test('maintenance blocks stale prerequisites, conflict, print/pause, watcher, missing macros and bad parameters',()=>{
 const mutations=[r=>r.webhooks.state='shutdown',r=>r.print_stats.state='printing',r=>r.print_stats.state='paused',r=>r.idle_timeout.state='Printing',r=>r.toolhead.homed_axes='xy',r=>r.toolchanger.detected_tool_number=2,r=>r.toolchanger.has_detection=false,r=>r.toolchanger.status='uninitialized',r=>r['tool T1']={detect_state:1},r=>r['gcode_macro LOAD_WATCH']={active:1},r=>delete r.configfile.settings['gcode_macro clean_nozzle']]
 for(const change of mutations) {const raw=state();change(raw); if(raw['tool T1']) raw['tool T2']={detect_state:1};assert.throws(()=>commandFor({action:'clean',tool:1},raw))}
 for(const input of [{action:'load',tool:1,temperature:169},{action:'load',tool:1,temperature:300},{action:'purge',tool:1,temperature:'240'},{action:'pickup',tool:'1\nG28'},{action:'clean',tool:1,script:'G28'},{action:'load_all',temperature:240,tool:1}])assert.throws(()=>commandFor(input,state()))
 const raw=state();raw['filament_switch_sensor T1_filament_sensor'].filament_detected=false;assert.throws(()=>commandFor({action:'purge',tool:1},raw),/Filament/)
 const status={...normalizeStatus(state()),capabilities:capabilities(state())};assert.match(toolActionReason(status,'clean',1,false),/aktuellen/);assert.match(toolActionReason(status,'clean',1,true,true),/Befehl/)
})
test('fan controls expose generic fans only and normalize configured maximum power',()=>{
 const raw=state();raw['fan_generic fan0']={speed:.36}
 assert.equal(normalizeStatus(raw).fans.find(f=>f.name==='fan0').percent,50)
 assert.equal(normalizeStatus(raw).fans.find(f=>f.name==='BedFans').percent,null)
 assert.equal(commandFor({action:'fan',fan:'BedFans',percent:50},raw).body.script,'SET_FAN_SPEED FAN=BedFans SPEED=0.5')
 assert.throws(()=>commandFor({action:'fan',fan:'bedfans',percent:50},raw))
 for(const percent of [0,25,50,100]) assert.equal(commandFor({action:'fan',fan:'fan0',percent},raw).body.script,`SET_FAN_SPEED FAN=fan0 SPEED=${percent/100}`)
 for(const fan of ['t0_hotend_fan','fan0\nM112','missing'])assert.throws(()=>commandFor({action:'fan',fan,percent:50},raw))
 for(const percent of [-1,101,'50',.5])assert.throws(()=>commandFor({action:'fan',fan:'fan0',percent},raw))
})
test('macro defaults come from live variables, respect limits and cannot be overridden by UI parameters',()=>{
 const raw=state();raw['gcode_macro _LOAD_SETTINGS'].temp_default=225
 assert.equal(capabilities(raw).filamentDefaults.load,225)
 assert.match(commandFor({action:'load',tool:1},raw).label,/225 °C/)
 assert.match(commandFor({action:'unload',tool:1},raw).label,/235 °C/)
 for(const action of ['load','unload','purge'])assert.throws(()=>commandFor({action,tool:1,temperature:240},raw),/parameter/i)
 for(const value of [null,169,300]){raw['gcode_macro _LOAD_SETTINGS'].temp_default=value;assert.throws(()=>commandFor({action:'load',tool:1},raw),/Makro-Standardtemperatur/)}
 raw['gcode_macro _LOAD_SETTINGS'].temp_default=240;raw['gcode_macro _UNLOAD_SETTINGS'].temp_default=null
 assert.throws(()=>commandFor({action:'unload_all'},raw),/Makro-Standardtemperatur/)
 assert.ok(!commandFor({action:'load_all'},raw).body.script.includes('TEMP='))
})
