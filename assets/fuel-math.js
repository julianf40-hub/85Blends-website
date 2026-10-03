/* Percent inputs are 0–100; volumes are gallons. No UI dependencies. */
(function(root){
  'use strict';
  const validPercent=x=>Number.isFinite(x)&&x>=0&&x<=100;
  function blend({tank,current,currentE,target,highE,gasE}){
    if(![tank,current].every(Number.isFinite)||tank<=0||current<0||current>tank||![currentE,target,highE,gasE].every(validPercent)||highE<=gasE)
      return {ok:false,title:'Check your inputs',message:'Enter a positive tank capacity, current gallons within that capacity, and ethanol percentages from 0 to 100. High-ethanol pump fuel must contain more ethanol than gasoline.'};
    const fill=tank-current,min=(current*currentE+fill*gasE)/tank,max=(current*currentE+fill*highE)/tank;
    if(target<min-1e-8||target>max+1e-8)return {ok:false,title:'Target not reachable',message:'With this fuel already in the tank, a full tank can reach E'+min.toFixed(1)+'–E'+max.toFixed(1)+'. Choose a target in that range, or recheck your current fuel and measured pump percentages.',min,max};
    const high=Math.max(0,Math.min(fill,(tank*target-current*currentE-fill*gasE)/(highE-gasE))),gas=fill-high;
    return {ok:true,high,gas,volume:tank,ethanol:(current*currentE+high*highE+gas*gasE)/tank,min,max};
  }
  function cost({tank,target,highE,gasE,highPrice,gasPrice,mpg,loss}){
    const fill=blend({tank,current:0,currentE:gasE,target,highE,gasE});
    if(!fill.ok){
      if(Number.isFinite(fill.min)&&Number.isFinite(fill.max))return {...fill,message:'With these pump fuels, an empty tank filled to capacity can reach E'+fill.min.toFixed(1)+'–E'+fill.max.toFixed(1)+'. Choose a target in that range or recheck the measured pump percentages.'};
      return fill;
    }
    if(![highPrice,gasPrice,mpg,loss].every(Number.isFinite)||highPrice<0||gasPrice<0||mpg<=0||loss<0||loss>=100)
      return {ok:false,title:'Check your inputs',message:'Enter nonnegative prices, positive gasoline MPG, and an MPG loss from 0 to less than 100%.'};
    const fraction=fill.high/tank,blendMpg=mpg*(1-loss/100*fraction),fillPrice=fill.high*highPrice+fill.gas*gasPrice,gasFill=tank*gasPrice;
    return {ok:true,...fill,blendMpg,fillPrice,gasFill,gasPer100:gasPrice/mpg*100,blendPer100:fillPrice/tank/blendMpg*100,miles:blendMpg*tank};
  }
  const api={blend,cost};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FuelMath=api;
})(typeof window!=='undefined'?window:globalThis);
