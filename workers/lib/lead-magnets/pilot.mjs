// Temporary production safety gate for the owner-controlled end-to-end test.
// This is a recipient restriction, not authentication. No other address or
// marketing step may be captured or delivered while the pilot is deployed.
const OWNER_RECIPIENT_SHA256='918d8f75c40628ecfab40fbd12cb12417baf1df6f198282f0bee5cdcf5d5f88f';
export async function isGuidePilotRecipient(email,digest=OWNER_RECIPIENT_SHA256){
 if(typeof email!=='string'||!/^[a-f0-9]{64}$/.test(digest))return false;
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email.trim().toLowerCase()));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')===digest;
}
