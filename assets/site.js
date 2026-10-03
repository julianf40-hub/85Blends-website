/* Shared disclosure navigation and calculator interactions. */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const menu=$('mobile-navigation'),toggle=$('menu-toggle');
  function closeMenu(restoreFocus=false){menu.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Open navigation');document.body.classList.remove('menu-open');if(restoreFocus)toggle.focus();}
  toggle.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close navigation':'Open navigation');document.body.classList.toggle('menu-open',open);});
  menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>closeMenu()));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden)closeMenu(true);});
  window.matchMedia('(min-width:1101px)').addEventListener('change',e=>{if(e.matches)closeMenu();});
  const bar=$('mobile-download');
  if(bar){let dismissed=false;try{dismissed=sessionStorage.getItem('85blends-download-dismissed')==='1';}catch{}
    if(dismissed){bar.hidden=true;document.body.classList.remove('has-download-bar');}
    $('dismiss-download').addEventListener('click',()=>{bar.hidden=true;document.body.classList.remove('has-download-bar');try{sessionStorage.setItem('85blends-download-dismissed','1');}catch{}});
    document.addEventListener('focusin',e=>document.body.classList.toggle('editing',e.target.matches('input,select,textarea')));
    document.addEventListener('focusout',()=>document.body.classList.remove('editing'));
  }
  const number=id=>{const value=$(id).value.trim();return value===''?NaN:Number(value);};
  const text=(id,value)=>{$(id).textContent=value;};
  const money=x=>'$'+x.toFixed(2);
  const blendForm=$('blend-form');
  if(blendForm){
    function updatePresets(){document.querySelectorAll('[data-target]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.target)===number('targetE'))));}
    function calculate(focus=false){
      const r=FuelMath.blend({tank:number('tank'),current:number('currentGallons'),currentE:number('currentE'),target:number('targetE'),highE:number('e85E'),gasE:number('gasE')});
      const result=$('blend-result');result.classList.toggle('error',!r.ok);$('blend-metrics').hidden=!r.ok;text('blend-result-title',r.ok?'Your fill-up plan':r.title);
      if(r.ok){text('e85Gallons',r.high.toFixed(2)+' gal');text('gasGallons',r.gas.toFixed(2)+' gal');text('finalGallons',r.volume.toFixed(2)+' gal');text('finalE','E'+r.ethanol.toFixed(1));text('resultNote','Planning estimate only. Verify pump percentages and follow your vehicle manufacturer or tuner requirements.');}
      else text('resultNote',r.message);
      updatePresets();if(focus)result.focus();
    }
    blendForm.addEventListener('submit',e=>{e.preventDefault();calculate(true);});
    blendForm.addEventListener('input',()=>calculate());
    document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>{$('targetE').value=b.dataset.target;calculate();}));
    calculate();
  }
  const costForm=$('cost-form');
  if(costForm){
    function calculateCost(){
      const r=FuelMath.cost({tank:number('cost-tank'),target:number('cost-target'),highE:number('cost-highE'),gasE:number('cost-gasE'),highPrice:number('cost-highPrice'),gasPrice:number('cost-gasPrice'),mpg:number('cost-mpg'),loss:number('cost-loss')});
      $('cost-metrics').hidden=!r.ok;$('cost-detail').hidden=!r.ok;
      if(!r.ok){text('cost-outcome',r.title+': '+r.message);$('cost-outcome').className='cost-outcome';return;}
      text('gas-per100',money(r.gasPer100));text('blend-per100',money(r.blendPer100));
      const delta=r.blendPer100-r.gasPer100;
      text('cost-outcome',Math.abs(delta)<.005?'Estimated driving cost is about equal.':('Blend costs '+money(Math.abs(delta))+' '+(delta>0?'more':'less')+' per 100 miles.'));
      $('cost-outcome').className='cost-outcome '+(delta>0?'higher':'lower');
      const fillDelta=r.fillPrice-r.gasFill;
      text('cost-detail','Full-tank price: '+money(r.fillPrice)+' blend vs '+money(r.gasFill)+' gasoline ('+money(Math.abs(fillDelta))+' '+(fillDelta>0?'higher':'lower')+' fill-up price). Estimated blend: '+r.blendMpg.toFixed(1)+' MPG · '+Math.round(r.miles)+' miles per tank.');
    }
    costForm.addEventListener('input',calculateCost);costForm.addEventListener('submit',e=>e.preventDefault());calculateCost();
  }
})();

