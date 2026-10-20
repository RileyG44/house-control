// Geometry and identity invariants behind room edits. Run: node web/tests/editor-model.mjs
import assert from 'node:assert/strict';
import * as M from '../src/edit/model.js';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/config.js';
import { wallSegments } from '../src/three/house.js';
import { inPolygon, polyArea, polyProblem } from '../src/geom.js';

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

// Rooms with angled walls: Riley's Studio, the default home.
const riley=JSON.parse(readFileSync(new URL('../public/plans/riley.json',import.meta.url)));
const bath=riley.rooms.find(r=>r.id==='bathroom');
assert.ok(inPolygon(bath.poly,[1,3])&&!inPolygon(bath.poly,[2.2,4.2]),'the corner behind the angled wall is outside');
assert.ok(Math.abs(polyArea(bath.poly)-(2.25*2.05-0.7*0.6/2))<1e-9);
assert.ok(Math.abs(M.area(bath)-polyArea(bath.poly))<1e-9);
assert.equal(M.roomAt(riley,[1,3]).id,'bathroom','the smaller room on top');
assert.equal(M.roomAt(riley,[2.2,4.2]).id,'studio');
assert.equal(polyProblem([[0,0],[2,2],[2,0],[0,2]]) !== null,true,'a bow tie is refused');
assert.throws(()=>normalize({rooms:[{id:'a',poly:[[0,0],[1,0]]}]}),/corner/);

const segs=wallSegments(normalize(structuredClone(riley)));
const near=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1])<0.01;
const onLine=(a,b)=>segs.filter(s=>{const l=Math.hypot(b[0]-a[0],b[1]-a[1]);
  const cross=(p)=>Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))/l;return cross(s.from)<0.01&&cross(s.to)<0.01;});
const angled=onLine([1.55,4.25],[2.25,3.65]);
assert.ok(angled.length>=1&&angled.every(s=>s.kind==='interior'),'the angled bathroom wall is one interior wall');
assert.ok(Math.abs(angled.reduce((t,s)=>t+s.len,0)-Math.hypot(0.7,0.6))<0.01,'it runs corner to corner');
assert.equal(angled.filter(s=>s.opening?.type==='door').length,1,'with the bathroom door on it');
const boundary=onLine([3.5,2.2],[7.15,2.2]).filter(s=>s.from[0]>=3.49);
assert.ok(boundary.length&&boundary.every(s=>s.kind==='interior'&&s.opening?.type==='open'),'kitchen and studio are open to each other');
const pony=onLine([0.65,4.25],[0.65,7.7]).filter(s=>!s.opening&&s.from[1]>5.8&&s.to[1]<6.3);
assert.ok(pony.length===1&&near(pony[0].from,[0.65,5.85])&&near(pony[0].to,[0.65,6.2]),'the pony wall between the closet openings');

// Cutting a corner turns a rect into a polygon with a short angled wall.
const cut={id:'c',rect:[0,0,4,3]};
assert.equal(M.cutCorner(cut,2,0.6),true);
assert.deepEqual(cut.poly,[[0,0],[4,0],[4,2.4],[3.4,3],[0,3]]);
assert.equal(cut.rect,undefined);
assert.ok(Math.abs(M.area(cut)-(12-0.18))<1e-9);
assert.equal(M.cutCorner({id:'t',rect:[0,0,0.12,3]},0,0.6),false,'too short to cut');
assert.equal(M.moveCorner(cut,3,[4,0]),false,'a drag that folds the room is refused');

// An opening slides along its angled wall and keeps its hinge end.
const doc2=M.ensureArrays(structuredClone(riley));
const door=doc2.openings.find(o=>o.type==='door'&&o.from[0]<2);
const wall=M.wallOf(doc2,door);
assert.ok(wall&&!M.openingAxis(door));
const span=M.openingSpan(door);
M.setOpeningSpan(door,M.placeOnWall(wall,span.a+span.w/2+0.5,span.w));
const moved=M.openingSpan(door);
assert.ok(Math.abs(moved.w-span.w)<0.01,'same width');
assert.ok(moved.a>=wall.a-1e-6&&moved.b<=wall.b+1e-6,'still on the wall, clear of its ends');
assert.deepEqual(M.wallOf(doc2,door),wall);
assert.ok(door.from[0]<door.to[0],'the hinge end is still "from"');
assert.equal(M.swingOf(doc2,door),'studio');
console.log('PASS polygon rooms, area and containment, angled walls on the default home, cut corners, sliding on an angled wall');
