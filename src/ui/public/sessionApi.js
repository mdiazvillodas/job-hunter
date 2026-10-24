'use strict';
// Expired access is renewed through the portal. Never replay a request, especially POST /api/hunt.
(function(root){
 let redirecting=false;
 async function request(input,options){
  const response=await root.fetch(input,options);
  if(response.status===401||(response.redirected&&new URL(response.url,root.location.href).hostname.startsWith('auth.'))){
   if(!redirecting){redirecting=true;root.location.assign(root.location.pathname+root.location.search+root.location.hash);}
   throw Error('Tu sesión venció. Volviendo al acceso seguro…');
  }
  return response;
 }
 root.SessionApi={request};
 if(root.document)root.document.addEventListener('DOMContentLoaded',()=>{
  // The local installer has no authentication portal. Cloud instances use auth.<host>.
  const host=root.location.hostname;
  if(!host||host==='localhost'||!host.includes('.')||/^[0-9.]+$/.test(host))return;
  for(const link of root.document.querySelectorAll('[data-session-logout]')){
   link.href='https://auth.'+host+'/logout?rd='+encodeURIComponent(root.location.origin);
   link.hidden=false;
  }
 });
})(window);
