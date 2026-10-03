const assert = require('node:assert/strict');
const {test} = require('node:test');
const {blend,cost} = require('../assets/fuel-math.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8, a+' != '+b);
const base={tank:18.5,current:2,currentE:10,target:60,highE:70,gasE:10};
test('existing ethanol and both pump percentages are conserved',()=>{const r=blend(base);assert.equal(r.ok,true);near(r.high,15.416666666666666);near(r.gas,1.083333333333334);near(r.high+r.gas,16.5);near(r.ethanol,60);});
test('unreachable E85 on E70 pump shows reachable maximum',()=>{const r=blend({...base,target:85});assert.equal(r.ok,false);near(r.max,63.513513513513516);assert.equal(r.title,'Target not reachable');});
test('below reachable minimum fails without clamping a false success',()=>assert.equal(blend({...base,currentE:60,target:0}).ok,false));
test('empty tank E30 with E85/E10 uses 20/75 proportion',()=>{const r=blend({...base,current:0,target:30,highE:85});near(r.high,18.5*20/75);near(r.ethanol,30);});
test('full tank at its current target requires no fuel',()=>{const r=blend({...base,current:18.5,currentE:60});assert.equal(r.ok,true);near(r.high,0);near(r.gas,0);});
test('full tank cannot change target by adding fuel',()=>assert.equal(blend({...base,current:18.5,currentE:10}).ok,false));
test('negative, missing, out-of-range and equal/reversed pump inputs are rejected',()=>{for(const bad of [{tank:0},{current:-1},{current:20},{currentE:101},{target:-1},{highE:10},{highE:0},{gasE:NaN}])assert.equal(blend({...base,...bad}).ok,false);});
const costBase={tank:18.5,target:85,highE:85,gasE:10,highPrice:2.89,gasPrice:3.49,mpg:25,loss:25};
test('lower fill-up price can mean higher driving cost',()=>{const r=cost(costBase);near(r.gasPer100,13.96);near(r.blendPer100,2.89/18.75*100);assert.ok(r.fillPrice<r.gasFill);assert.ok(r.blendPer100>r.gasPer100);});
test('gasoline baseline incurs no ethanol MPG penalty',()=>{const r=cost({...costBase,target:10});near(r.blendMpg,25);near(r.blendPer100,r.gasPer100);});
test('partial blend MPG penalty scales with high-fuel proportion',()=>{const r=cost({...costBase,target:30});near(r.blendMpg,25*(1-.25*20/75));});
test('cost comparison rejects invalid MPG, losses, prices and unreachable target',()=>{for(const bad of [{mpg:0},{loss:100},{loss:-1},{highPrice:-1},{gasPrice:NaN},{highE:70}])assert.equal(cost({...costBase,...bad}).ok,false);});
test('zero fuel prices are valid and finite',()=>{const r=cost({...costBase,highPrice:0,gasPrice:0});assert.equal(r.ok,true);near(r.blendPer100,0);near(r.gasPer100,0);});

