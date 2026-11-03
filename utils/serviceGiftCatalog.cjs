'use strict';
const {timingSafeEqual}=require('node:crypto');
const HEART_PRICE_MESSAGE='/channels/1513513773686722701/messages/1513821451650600970';

function parseHeartGifts(content){
 const gifts=new Map();
 for(const line of String(content||'').split('\n')){
  const match=line.match(/^\s*(<a?:[\w]+:\d+>)\s*([^<>\n]+?)\s+<a?:[\w]+:\d+>\s*([\d,]+)\s*T\s*$/);
  if(!match)continue;
  const [, , name,amount]=match;
  const price=Number(amount.replaceAll(',',''));
  if(name.length<=100&&Number.isSafeInteger(price)&&price>0)gifts.set(name,{key:name,name,price,unit:'T'});
 }
 if(!gifts.size)throw Error('暫時讀不到本店心動禮物價目，請稍後再試。');
 return [...gifts.values()];
}

function createServiceGiftCatalog({organization,tipGifts,readMessage,token}){
 const regular=tipGifts.filter(gift=>!gift.customPrice&&gift.name&&gift.price>0)
  .map(({key,name,price})=>({key,name,price,unit:'ASD'}));
 let recent, pending;
 async function heart(){
  if(organization!=='qiunai')return [];
  if(recent&&recent.until>Date.now())return recent.gifts;
  if(!pending)pending=Promise.resolve().then(()=>readMessage(HEART_PRICE_MESSAGE))
   .then(message=>{
    const gifts=parseHeartGifts(message.content);
    recent={gifts,until:Date.now()+60_000};
    return gifts;
   }).finally(()=>{pending=null;});
  return pending;
 }
 async function handleHttpRequest(request,response){
  if(request.method!=='GET'||request.url!=='/service-gifts')return false;
  const received=Buffer.from(request.headers.authorization||'');
  const expected=Buffer.from(`Bearer ${token||''}`);
  const allowed=Boolean(token)&&received.length===expected.length&&timingSafeEqual(received,expected);
  response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Cache-Control','no-store');
  response.statusCode=allowed?200:401;
  response.end(JSON.stringify(allowed?{organization,regular,heart:await heart().catch(()=>null)}:{ok:false}));
  return true;
 }
 return {heart,handleHttpRequest};
}

module.exports={createServiceGiftCatalog,parseHeartGifts};
