import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOCK_SPEED_PRESETS,MAX_CLOCK_SPEED,createClockControls} from '../dist/game-clock-controls.js';

test('a new paused clock resumes at the safe first preset and preserves the selected preset while paused',()=>{
  const clock=createClockControls();
  assert.deepEqual(clock.getState(),{speed:0,lastRunningSpeed:1,paused:true,activePreset:1});
  assert.deepEqual(clock.togglePause(),{ok:true,state:{speed:1,lastRunningSpeed:1,paused:false,activePreset:1}});
  assert.deepEqual(clock.togglePause(),{ok:true,state:{speed:0,lastRunningSpeed:1,paused:true,activePreset:1}});
});

test('choosing each preset starts its exact rate and pause/resume restores that rate',()=>{
  const clock=createClockControls(37);
  for(const speed of CLOCK_SPEED_PRESETS){
    const selected=clock.setSpeed(String(speed));assert.equal(selected.ok,true);assert.equal(selected.state.speed,speed);assert.equal(selected.state.activePreset,speed);assert.equal(selected.state.paused,false);
    assert.equal(clock.togglePause().state.speed,0);assert.equal(clock.getState().activePreset,speed);assert.equal(clock.togglePause().state.speed,speed);
  }
  assert.equal(Object.isFrozen(CLOCK_SPEED_PRESETS),true);
});

test('custom imported and typed numeric speeds survive pause or an explicit zero without rounding to a preset',()=>{
  const clock=createClockControls(37.125);
  assert.equal(clock.getState().activePreset,null);assert.equal(clock.togglePause().state.lastRunningSpeed,37.125);assert.equal(clock.togglePause().state.speed,37.125);
  assert.equal(clock.setSpeed(' 9.25 ').state.speed,9.25);assert.equal(clock.setSpeed(0).state.lastRunningSpeed,9.25);assert.equal(clock.setSpeed('0').state.lastRunningSpeed,9.25);assert.equal(clock.togglePause().state.speed,9.25);
  assert.equal(clock.setSpeed('1e2').state.speed,100);assert.equal(clock.getState().activePreset,null);
  assert.equal(clock.setSpeed(MAX_CLOCK_SPEED).state.speed,MAX_CLOCK_SPEED);assert.equal(clock.togglePause().state.speed,0);assert.equal(clock.togglePause().state.speed,MAX_CLOCK_SPEED);
});

test('invalid custom input never pauses, starts or changes the remembered speed and valid input can recover immediately',()=>{
  const clock=createClockControls(60),before=clock.getState();
  for(const value of ['', '  ', '60秒', '0x10', 'Infinity', 'NaN', NaN, Infinity,-1,86401,null,undefined,true,false,[],{},'1e999']){
    const result=clock.setSpeed(value);assert.equal(result.ok,false);assert.ok(result.error);assert.deepEqual(result.state,before);assert.deepEqual(clock.getState(),before);
  }
  assert.equal(clock.setSpeed(42).ok,true);assert.equal(clock.togglePause().state.speed,0);
  assert.equal(clock.setSpeed('').ok,false);assert.equal(clock.getState().lastRunningSpeed,42);assert.equal(clock.togglePause().state.speed,42);
  for(const initial of [null,'',-1,86401,NaN,Infinity,{}])assert.throws(()=>createClockControls(initial),RangeError);
});

test('returned snapshots are independent and using the model does not mutate an external game object',()=>{
  const game={speed:10,time:1234},clock=createClockControls(game.speed),snapshot=clock.getState();snapshot.speed=0;snapshot.lastRunningSpeed=999;snapshot.activePreset=null;
  assert.deepEqual(clock.getState(),{speed:10,lastRunningSpeed:10,paused:false,activePreset:10});
  const result=clock.setSpeed(300);result.state.speed=0;result.state.lastRunningSpeed=1;
  assert.equal(clock.getState().speed,300);assert.equal(clock.togglePause().state.lastRunningSpeed,300);assert.deepEqual(game,{speed:10,time:1234});
});
