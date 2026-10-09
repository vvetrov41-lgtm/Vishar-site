/* Aftercare motion enhancements (progressive, never hides the guide).
   The route selector is owned by vishar-stable-enhancement; do not change it. */
(()=>{
  'use strict';
  const root=document.getElementById('mobile-fallback');
  if(!root || !('IntersectionObserver' in window)) return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(reduced.matches) return;
  const sections=Array.from(root.querySelectorAll('.mf-section'));
  const childSelectors=':scope > h2,:scope > .lead,:scope > h3,:scope > .grid2,:scope > .tiles,:scope > .rule,:scope > .stat,:scope > .photo,:scope > .product,:scope > ol,:scope > ul,:scope > .timeline,:scope > .warning,:scope > .review';
  const io=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting || entry.target.closest('[hidden]')) continue;
      const el=entry.target;
      el.classList.add(el.classList.contains('mf-section')?'ac-section-in':'ac-morph-in');
      io.unobserve(el);
    }
  },{root:null,threshold:0.06,rootMargin:'0px 0px -7% 0px'});
  for(const section of sections){
    io.observe(section);
    const elements=Array.from(section.querySelectorAll(childSelectors));
    for(let i=0;i<elements.length;i++){
      const el=elements[i];
      // Stagger changes in content groups, not every list item.
      el.style.setProperty('--ac-delay',Math.min(i,6)*55+'ms');
      io.observe(el);
    }
  }
  // Route toggles can make a previously hidden section visible. The observer
  // notices it once visible, and the current film/no-film behavior is unchanged.
})();
