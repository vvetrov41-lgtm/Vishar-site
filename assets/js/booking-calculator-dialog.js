(() => {
 const dialog=document.getElementById("booking-calculator-dialog"),open=document.getElementById("booking-calculator-open"),close=document.getElementById("booking-calculator-close");
 if(!dialog||!open||typeof dialog.showModal!=="function"||document.documentElement.getAttribute("data-enquiry-form")!=="v2")return;
 let previousOverflow="";
 open.addEventListener("click",e=>{if(!document.querySelector("#booking-calculator-dialog .planner:not([hidden])"))return;e.preventDefault();if(dialog.open)return;previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";dialog.showModal();dialog.dispatchEvent(new Event("vishar-calculator-open"));close.focus();});
 close.addEventListener("click",()=>dialog.close());
 dialog.addEventListener("close",()=>{document.body.style.overflow=previousOverflow;open.focus();});
})();
