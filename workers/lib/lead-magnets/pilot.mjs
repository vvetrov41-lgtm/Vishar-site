// Temporary production safety gate for owner-controlled end-to-end tests.
// Recipient restriction, not authentication. No other recipients or marketing
// steps may be captured or delivered while this pilot is deployed.
const OWNER_RECIPIENT_SHA256=Object.freeze([
 '918d8f75c40628ecfab40fbd12cb12417baf1df6f198282f0bee5cdcf5d5f88f',
 '0cc27496a8eda14eae43332b11ee85b56cc996e5e5cded076021d97034a6bd94',
]);
export async function isGuidePilotRecipient(email,digests=OWNER_RECIPIENT_SHA256){
 if(typeof email!=='string'||!Array.isArray(digests)||!digests.length||!digests.every(d=>typeof d==='string'&&/^[a-f0-9]{64}$/.test(d)))return false;
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email.trim().toLowerCase()));
 return digests.includes(Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join(''));
}
