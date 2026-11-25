// Cloudflare's live list-queues response uses script for Worker consumers,
// while the published API schema also permits script_name. Validate both.
export function queueOwnedBy(queue,name,requireBoth=false){
 if(!queue||queue.queue_name!==name||!Array.isArray(queue.producers)||!Array.isArray(queue.consumers))return false;
 const p=queue.producers,c=queue.consumers;
 if(!Number.isInteger(queue.producers_total_count)||!Number.isInteger(queue.consumers_total_count)||queue.producers_total_count!==p.length||queue.consumers_total_count!==c.length)return false;
 const owns=x=>x?.type==='worker'&&(x.script??x.script_name)===name&&(x.script===undefined||x.script===name)&&(x.script_name===undefined||x.script_name===name);
 if(!p.every(owns)||!c.every(owns)||p.length>1||c.length>1)return false;
 return !requireBoth||(p.length===1&&c.length===1);
}
