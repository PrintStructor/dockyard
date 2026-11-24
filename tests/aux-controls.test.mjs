import test from 'node:test'
import assert from 'node:assert/strict'
import {commandFor,capabilities} from '../server/control.mjs'
import {normalizeStatus} from '../server/status.mjs'
import {auxActionReason,ledProfiles} from '../src/aux-action-state.mjs'
const state=()=>{
 const config={toolchanger:{},'gcode_macro pause':{},'gcode_macro resume':{},'gcode_macro load_watch':{},'gcode_macro load_watch_stop':{},'gcode_macro load_filament':{},'delayed_gcode _load_watch_tick':{}}
 for(const p of ledProfiles)config[`gcode_macro ${p.macro.toLowerCase()}`]={}
 const raw={'gcode_macro _LOAD_SETTINGS':{temp_default:240},webhooks:{state:'ready'},print_stats:{state:'standby'},idle_timeout:{state:'Idle'},toolchanger:{has_detection:true,tool_number:1,detected_tool_number:1,status:'ready'},toolhead:{homed_axes:'xyz'},'gcode_macro LOAD_WATCH':{active:0,temp:240},configfile:{settings:config}}
 for(let id=0;id<6;id++){config[id?`extruder${id}`:'extruder']={min_extrude_temp:170,max_temp:300};raw[`filament_switch_sensor T${id}_filament_sensor`]={enabled:true,filament_detected:false}}
 return raw
}
test('LED actions whitelist configured profiles and never invoke print or motion',()=>{
 for(const profile of ledProfiles)assert.equal(commandFor({action:'led',profile:profile.id},state()).body.script,profile.macro)
 for(const profile of ['PRINT_START','wake\nG28',null])assert.throws(()=>commandFor({action:'led',profile},state()))
 const raw=state();delete raw.configfile.settings['gcode_macro wake_up'];assert.throws(()=>commandFor({action:'led',profile:'wake'},raw),/konfiguriert/)
})
test('pause and resume respect print state, while pause allows the installed tool-loss handler',()=>{
 const raw=state();assert.throws(()=>commandFor({action:'pause'},raw),/laufender/)
 raw.print_stats.state='printing';raw.toolchanger.status='error';assert.equal(commandFor({action:'pause'},raw).body.script,'PAUSE')
 assert.throws(()=>commandFor({action:'resume'},raw),/pausierter/)
 raw.print_stats.state='paused';assert.throws(()=>commandFor({action:'resume'},raw),/Toolchanger/)
 raw.toolchanger.status='ready';assert.equal(commandFor({action:'resume'},raw).body.script,'RESUME')
 raw.toolhead.homed_axes='xy';assert.throws(()=>commandFor({action:'resume'},raw),/referenziert/)
})
test('initialization permits startup and unique detection mismatch but not printing or conflicts',()=>{
 const raw=state();raw.toolhead.homed_axes='';raw.toolchanger.status='uninitialized';raw.toolchanger.tool_number=-1
 assert.equal(commandFor({action:'initialize'},raw).body.script,'INITIALIZE_TOOLCHANGER\nM400')
 for(const printState of ['printing','paused']){raw.print_stats.state=printState;assert.throws(()=>commandFor({action:'initialize'},raw),/gesperrt/)}
 raw.print_stats.state='standby';raw['tool T0']={detect_state:1};raw['tool T1']={detect_state:1};assert.throws(()=>commandFor({action:'initialize'},raw),/Eindeutige/)
})
test('load watcher arms with configured temperature and all six sensors; finish remains available during automatic motion',()=>{
 const raw=state();assert.equal(commandFor({action:'watch_start'},raw).body.script,'LOAD_WATCH')
 for(const temperature of [0,169,300,'240'])assert.throws(()=>commandFor({action:'watch_start',temperature},raw),/parameter/i)
 raw['gcode_macro _LOAD_SETTINGS'].temp_default=300;assert.throws(()=>commandFor({action:'watch_start'},raw),/Makro-Standardtemperatur/);raw['gcode_macro _LOAD_SETTINGS'].temp_default=240
 raw['filament_switch_sensor T3_filament_sensor'].enabled=false;assert.throws(()=>commandFor({action:'watch_start'},raw),/Filamentsensoren/)
 raw['filament_switch_sensor T3_filament_sensor'].enabled=true;raw.toolhead.homed_axes='';assert.throws(()=>commandFor({action:'watch_start'},raw),/homen/)
 raw.toolhead.homed_axes='xyz';raw.print_stats.state='paused';assert.throws(()=>commandFor({action:'watch_start'},raw),/ruhendem/)
 raw['gcode_macro LOAD_WATCH'].active=1;raw.idle_timeout.state='Printing';assert.equal(commandFor({action:'watch_stop'},raw).body.script,'LOAD_WATCH_STOP')
 assert.throws(()=>commandFor({action:'resume'},raw),/Einlegehilfe/)
 assert.throws(()=>commandFor({action:'watch_stop',temperature:240},raw),/parameter/i)
 const status={...normalizeStatus(raw),capabilities:capabilities(raw)};assert.match(auxActionReason(status,'watch_stop',false),/aktuellen/)
})

test('watcher may arm without prior homing only when installed toolchanger permits automatic homing',()=>{
 const raw=state();raw.toolhead.homed_axes=''
 assert.throws(()=>commandFor({action:'watch_start'},raw),/homen/)
 raw.configfile.settings.toolchanger.on_axis_not_homed='home'
 assert.equal(commandFor({action:'watch_start'},raw).body.script,'LOAD_WATCH')
 raw.configfile.settings.toolchanger.on_axis_not_homed='abort'
 assert.throws(()=>commandFor({action:'watch_start'},raw),/homen/)
})
