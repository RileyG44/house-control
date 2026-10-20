// Geometry and identity invariants behind room edits. Run: node web/tests/editor-model.mjs
import assert from 'node:assert/strict';
import * as M from '../src/edit/model.js';

const doc=M.ensureArrays({name:'Nested home',
  rooms:[{id:'studio',name:'Studio',rect:[0,0,6,6],floor:'oak'},
    {id:'bath',name:'Bathroom',rect:[4,0,2,2],floor:'tile'}],
  lights:[{id:'lamp',name:'Bathroom lamp',type:'ceiling',room:'bath',pos:[5,1],link:{service:'wiz',id:'real-device'}}],
  acs:[{id:'ac',name:'AC',room:'studio',pos:[0,3],wall:'west'}],
  furniture:[{type:'plant',pos:[8,2]}],
  scenes:[{id:'cozy',name:'Cozy',lights:{lamp:{on:true}},acs:{ac:{on:true}}}],
});
assert.equal(M.roomAt(doc,[5,1]).id,'bath');
assert.equal(M.roomAt(doc,[2,3]).id,'studio');
assert.ok(M.bounds(doc).maxX>8,'fit includes furniture outside all rooms');
const riders=M.riders(doc,doc.rooms[0]);
assert.deepEqual(riders.rooms.map(r=>r.id),['bath']);
assert.deepEqual(riders.lights.map(l=>l.id),['lamp']);
assert.deepEqual(riders.acs.map(a=>a.id),['ac']);

M.snapAC(doc,doc.acs[0],[5,.1]);
assert.equal(doc.acs[0].room,'bath');
assert.equal(doc.acs[0].wall,'north');
assert.equal(doc.acs[0].pos[1],0);

M.deleteRoom(doc,doc.rooms[1]);
assert.equal(doc.lights[0].room,'studio','nested-room removal reassigns the lamp');
assert.deepEqual(doc.lights[0].link,{service:'wiz',id:'real-device'});
assert.equal(doc.acs[0].room,'studio');
assert.deepEqual(doc.scenes[0].lights.lamp,{on:true});

M.removeItem(doc,{kind:'light',id:'lamp'});
M.removeItem(doc,{kind:'ac',id:'ac'});
assert.deepEqual(doc.scenes[0].lights,{});
assert.deepEqual(doc.scenes[0].acs,{});
const l1=M.addLight(doc,'table',doc.rooms[0]);
const l2=M.addLight(doc,'table',doc.rooms[0]);
const copy=M.duplicate(doc,{kind:'light',id:l1.id});
const ids=[...doc.rooms,...doc.lights,...doc.acs,...doc.scenes].map(x=>x.id);
assert.equal(new Set(ids).size,ids.length);
assert.notEqual(l1.id,l2.id);
assert.notEqual(copy.id,l1.id);
assert.equal(M.check(doc).error,null);
console.log('PASS nested rooms, room riders, AC wall snapping, linked-device reassignment, scene cascades, unique IDs');
