(() => {
 const dialog=document.getElementById("booking-calculator-dialog"),open=document.getElementById("booking-calculator-open"),close=document.getElementById("booking-calculator-close"),root=document.getElementById("enquiry-v2");
 if(!dialog||!open||!root||typeof dialog.showModal!=="function"||document.documentElement.getAttribute("data-enquiry-form")!=="v2")return;
 let previousOverflow="",trigger=null;
 function show(e,link){
  if(!dialog.querySelector(".planner:not([hidden])"))return;
  e.preventDefault();if(dialog.open)return;trigger=link;previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";
  dialog.showModal();dialog.dispatchEvent(new CustomEvent("vishar-calculator-open",{detail:{project:root.visharEnquiryV2?.calculatorProject()||null}}));close.focus();
 }
 open.addEventListener("click",e=>show(e,open));
 root.addEventListener("click",e=>{const link=e.target.closest("[data-calculator-open]");if(link)show(e,link);});
 close.addEventListener("click",()=>dialog.close());
 dialog.addEventListener("close",()=>{document.body.style.overflow=previousOverflow;if(trigger?.isConnected)trigger.focus();else root.querySelector("#ef-section")?.focus({preventScroll:true});trigger=null;});
})();
