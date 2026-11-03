'use strict';
const {randomUUID}=require('node:crypto');
const engine=require('./serviceTemplateEngine.cjs');
const STORES={qiunai:{name:'秋奈電競',guild:'1513174069087047731',channel:'1566885603637854269',role:'1513203868895412305',staff:'qiunai_staff'},deepnight:{name:'深夜不關燈',guild:'1501836172199202856',channel:'1566890399765762208',role:'1502010574781943989',staff:'players'}};
const DEEPNIGHT_GIFT_TEMPLATES={
 tip_1999:'gift-broadcast-tip-1999',
 tip_16888:'gift-broadcast-tip-16888',
 tip_custom:'exclusive-gift-broadcast',
};
const row=(component)=>({type:1,components:[component]});
const actionButton=(id,label)=>({type:2,style:1,custom_id:id,label});
const button=(id,label)=>row(actionButton(id,label));
const QUICK_ACTIONS=[
 ['guide-bot','請老闆開單'],
 ['ask-accept','詢問能否接單'],
 ['ask-review','請老闆留好評'],
 ['handover-line','交接班'],
 ['clock-in-out','上下班打卡'],
];
const privateMessage={flags:64,allowedMentions:{parse:[]}};
module.exports.createServiceTemplatePanel=function({client,supabase,organization,tipGifts=[],tipBroadcasts={},loadHeartGifts=async()=>[],now=()=>Date.now()}){
 const store=STORES[organization];if(!store)throw Error('客服面板店家不正確');
 const gifts=new Map(tipGifts.filter(gift=>typeof gift?.key==='string'&&gift.key.length<=100&&
  typeof gift.name==='string'&&gift.name.trim()&&(gift.customPrice||Number.isFinite(gift.price)&&gift.price>0))
  .map(gift=>[gift.key,gift]));
 const giftOptions=[...gifts.values()].map(gift=>({
  label:gift.name.slice(0,100),value:gift.key,
  description:(gift.customPrice?'自行填寫禮物名稱':`${gift.price.toLocaleString('zh-TW')} ASD`).slice(0,100),
 }));
 function giftMenu(page=0){
  const start=page*24;
  const options=giftOptions.length<=25?giftOptions:giftOptions.slice(start,start+24);
  const more=giftOptions.length>25;
  const next=start+24<giftOptions.length?page+1:0;
  return row({type:3,custom_id:'svc:gift',placeholder:page?`打賞品項・第 ${page+1} 頁`:'選擇本店打賞品項，直接產生播報',
   options:more?[...options,{label:next?'查看更多打賞品項':'回到第一頁',value:`page:${next}`}]:options});
 }
 function heartMenu(choices){
  return row({type:3,custom_id:'svc:heart',placeholder:'選擇本店心動禮物',
   options:[...choices.slice(0,24).map(gift=>({label:gift.name,value:gift.key,description:`${gift.price.toLocaleString('zh-TW')} T`})),
    {label:'客製心動禮物（自行填寫）',value:'__custom__'}]});
 }
 const marker=`service-template-panel:v1:${organization}`,friendlyFooter=`${store.name}客服工具・確認內容後再貼上`,drafts=new Map();let panelPromise=null;
 const isOurPanel=message=>message?.author?.id===client.user?.id
  &&message?.embeds?.some(embed=>[marker,friendlyFooter].includes(embed.footer?.text));
 let panelEdit=Promise.resolve();
 function editPanel(task){
  const edit=panelEdit.then(task);
  panelEdit=edit.catch(()=>{});
  return edit;
 }
 function resetPanelSelection(message,selectedId){
  return editPanel(async()=>{
   const current=await message.fetch(true);
   if(!isOurPanel(current))return;
   const components=current.components.map(component=>component.toJSON());
   const selected=components.flatMap(row=>row.components)
    .find(component=>component.type===3&&component.custom_id===selectedId);
   if(!selected)return;
   // A new component ID discards the previous selection in Discord's client.
   selected.custom_id=`${selectedId.split(':reset:')[0]}:reset:${randomUUID()}`;
   selected.options=selected.options.map(option=>({...option,default:false}));
   await current.edit({components});
  }).catch(error=>{
   console.warn('[客服模板] 無法重設操作面板選單',error.code||error.name);
  });
 }
 const scope=(template)=>({organization,version:template.version});
 const checked=async(query)=>{const result=await query;if(result.error)throw result.error;return result.data;};
 async function list(){const templates=await checked(supabase.from('service_templates').select('*').eq('organization_code',organization).eq('is_active',true).order('title'));return templates.filter((template)=>{try{engine.validateTemplate(template,scope(template));return true;}catch{return false;}});}
 async function load(id){if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('請重新選擇模板');const template=await checked(supabase.from('service_templates').select('*').eq('organization_code',organization).eq('id',id).maybeSingle());if(!template)throw Error('模板不存在或已停用');engine.validateTemplate(template,scope(template));return template;}
 async function allowed(interaction){
  if(interaction.guildId!==store.guild||interaction.channelId!==store.channel)return false;
  const actor=String(interaction.user?.id||'');if(!/^\d{15,22}$/.test(actor))return false;
  const assignment=await checked(supabase.from('erp_role_assignments').select('role,is_active').eq('organization_code',organization).eq('discord_id',actor).maybeSingle());
  if(assignment?.is_active===false)return false;
  if(actor==='847840193859682304'||['super_admin','store_manager','customer_service'].includes(assignment?.role))return true;
  const permissions=interaction.memberPermissions;
  if(permissions?.has?.(8n))return true;
  const roles=Array.isArray(interaction.member?.roles)?interaction.member.roles:[...interaction.member?.roles?.cache?.keys?.()||[]];
  if(!roles.includes(store.role))return false;
  const staff=await checked(supabase.from(store.staff).select('discord_id,is_active').eq('discord_id',actor).maybeSingle());
  return Boolean(staff&&staff.is_active!==false);
 }
 function sweep(){for(const [id,draft] of drafts)if(draft.expires<=now())drafts.delete(id);}
 function draftFor(interaction,id){sweep();const draft=drafts.get(id);if(!draft||draft.actor!==interaction.user.id)throw Error('這份表單已過期或不屬於你，請重新選擇模板');return draft;}
 function modal(id,draft){
  const fields=draft.pages[draft.page];
  return {custom_id:`svc:submit:${id}:${draft.page}`,title:`${draft.title.slice(0,30)} ${draft.page+1}/${draft.pages.length}`,
   components:fields.map(field=>row({
    type:4,custom_id:field.key,label:field.label,style:field.type==='paragraph'?2:1,required:field.required===true,
    max_length:Math.min(field.maxLength||(field.type==='paragraph'?2000:500),4000),
    ...(field.type==='choice'?{placeholder:field.options.join('／').slice(0,100)}:{}),
    ...(draft.defaults[field.key]?{value:draft.defaults[field.key]}:{}),
   }))};
 }
 async function beginTemplate(interaction,template,gift){
  const giftLabel=template.slug==='heart-gift-broadcast'?'心動禮物名稱':'禮物名稱';
  const selectedName=gift&&!gift.customPrice?template.fields.find(field=>field.label===giftLabel&&field.type==='text'):null;
  if(gift&&!gift.customPrice&&!selectedName)throw Error('禮物播報模板欄位已變更，請重新選擇模板。');
  const selectedPrice=selectedName&&organization==='deepnight'
   ?template.fields.find(field=>field.label==='禮物單價'&&field.type==='text'):null;
  const broadcast=selectedName&&organization==='qiunai'&&template.slug==='gift-broadcast'
   ?tipBroadcasts[gift.key]:null;
  const copyField=broadcast?template.fields.find(field=>field.label==='禮物的文案'):null;
  const emojiField=broadcast?template.fields.find(field=>field.label==='禮物的表情符號'):null;
  const fixedInputs=[];
  if(selectedName)fixedInputs.push([selectedName, [gift.name,!emojiField&&broadcast?.emoji].filter(Boolean).join(' ')]);
  if(selectedPrice)fixedInputs.push([selectedPrice,String(gift.price)]);
  if(copyField)fixedInputs.push([copyField,broadcast.description]);
  if(emojiField&&broadcast.emoji)fixedInputs.push([emojiField,broadcast.emoji]);
  const fixedFields=fixedInputs.map(([field])=>field);
  const fixedValues=engine.normalizeValues({fields:fixedFields},Object.fromEntries(
   fixedInputs.map(([field,value])=>[field.key,value])));
  const fields=template.fields.filter(field=>!fixedFields.includes(field));
  const pages=engine.templatePages({...template,fields,body:'預覽欄位'},scope(template));
  if(!fields.length){await output(interaction,template,fixedValues);return;}
  const defaults={};
  if(selectedName){
   for(const field of fields){
    const value=field.label==='禮物組數'?'1':field.label==='祝福人數（含送禮人）'?'兩':
     field.label==='禮物的表情符號'&&template.slug==='gift-broadcast'?'🎁':field.label==='禮物的文案'?'謝謝老闆的心意！':'';
    if(value&&['text','paragraph'].includes(field.type)&&value.length<=(field.maxLength||500))defaults[field.key]=value;
   }
  }
  for(const [existingId,existing] of drafts)if(existing.actor===interaction.user.id&&existing.templateId===template.id)drafts.delete(existingId);
  if(drafts.size>=500||[...drafts.values()].filter(draft=>draft.actor===interaction.user.id).length>=5)throw Error('未完成的表單太多，請完成後再試，或等待十五分鐘');
  const draftId=randomUUID();
  const draft={actor:interaction.user.id,templateId:template.id,version:template.version,title:selectedName?gift.name:template.title,
   pages,page:0,state:'editing',values:{...fixedValues},defaults,expires:now()+15*60*1000};
  drafts.set(draftId,draft);
  try{await interaction.showModal(modal(draftId,draft));}catch(error){drafts.delete(draftId);throw error;}
 }
 async function output(interaction,template,values){const text=engine.compileTemplate(template,values,scope(template));const preview=text.replace(/```/g,'`\u200b``');const title=String(template.title).slice(0,100);const content=preview.length<=1750?`已產生 ${store.name}「${title}」。確認後自行複製貼上：\n\n\`\`\`\n${preview}\n\`\`\``:`已產生 ${store.name}「${title}」。內容較長，請開啟下方文字檔複製。`;
  const payload={content,components:[],allowedMentions:{parse:[]},files:[{attachment:Buffer.from(text,'utf8'),name:'客服模板.txt'}]};
  if(interaction.deferred||interaction.replied)await interaction.editReply(payload);else await interaction.reply({...privateMessage,...payload});
 }
 async function handleInteraction(interaction){
  const customId=interaction.customId;if(typeof customId!=='string'||!customId.startsWith('svc:'))return false;
  let shouldReset=false;
  try{
   sweep();
   if(!await allowed(interaction)){await interaction.reply({...privateMessage,content:'僅本店客服與主管可以在指定頻道使用此面板。'});return true;}
   shouldReset=interaction.isStringSelectMenu?.()&&isOurPanel(interaction.message);
   const [,action,id,pageText]=customId.split(':');
   if(action==='category'){
    await interaction.deferReply({flags:64});
    const templates=(await list()).filter((template)=>template.category===interaction.values?.[0]);
    if(!templates.length){await interaction.editReply({content:'這個分類目前沒有可用模板，請重新選擇。',allowedMentions:{parse:[]}});return true;}
    await interaction.editReply({content:`${store.name}｜選擇模板（只產生文字，不會自動發布）：`,components:[row({type:3,custom_id:'svc:template',placeholder:'選擇話術模板',options:templates.slice(0,25).map((template)=>({label:template.title.slice(0,100),value:template.id,description:(template.description||template.category).slice(0,100)}))})],allowedMentions:{parse:[]}});
   }else if(action==='template'||action==='quick'){
    const template=await load(action==='quick'?id:interaction.values?.[0]);
    if(template.slug==='gift-broadcast'&&giftOptions.length){
     await interaction.reply({...privateMessage,content:`${store.name}｜禮物播報`,components:[giftMenu()]});
    }else if(template.slug==='heart-gift-broadcast'&&organization==='qiunai'){
     await interaction.deferReply({flags:64});
     const choices=await loadHeartGifts();
     await interaction.editReply({content:`${store.name}｜心動禮物播報`,components:[heartMenu(choices)],allowedMentions:{parse:[]}});
    }else{
     await beginTemplate(interaction,template);
    }
   }else if(action==='heart'&&organization==='qiunai'){
    const choice=interaction.values?.[0];
    const selected=choice==='__custom__'?null:(await loadHeartGifts()).find(gift=>gift.key===choice);
    if(choice!=='__custom__'&&!selected)throw Error('找不到此店的心動禮物，請重新選擇。');
    const template=await checked(supabase.from('service_templates').select('*').eq('organization_code',organization).eq('slug','heart-gift-broadcast').maybeSingle());
    if(!template)throw Error('心動禮物播報模板目前沒有開放。');
    engine.validateTemplate(template,scope(template));
    await beginTemplate(interaction,template,selected);
   }else if(action==='gift'){
    const choice=interaction.values?.[0]||'';
    if(/^page:\d+$/.test(choice)&&giftOptions.length>25){
     const page=Number(choice.slice(5));
     if(page>=Math.ceil(giftOptions.length/24))throw Error('請重新選擇打賞品項。');
     await interaction.reply({...privateMessage,content:`${store.name}｜打賞品項`,components:[giftMenu(page)]});
     return true;
    }
    const gift=gifts.get(choice);
    if(!gift)throw Error('找不到此店的打賞品項，請重新選擇。');
    const specialSlug=organization==='deepnight'?DEEPNIGHT_GIFT_TEMPLATES[gift.key]:null;
    const template=await checked(supabase.from('service_templates').select('*').eq('organization_code',organization).eq('slug',specialSlug||'gift-broadcast').maybeSingle());
    if(!template)throw Error('禮物播報模板目前沒有開放。');
    engine.validateTemplate(template,scope(template));
    await beginTemplate(interaction,template,specialSlug?null:gift);
   }else if(action==='continue'){
    const draft=draftFor(interaction,id);if(!['ready','editing'].includes(draft.state))throw Error('這一頁已開啟，請完成目前的表單');
    const template=await load(draft.templateId);engine.validateTemplate(template,{organization,version:draft.version});
    draft.state='editing';try{await interaction.showModal(modal(id,draft));}catch(error){draft.state='ready';throw error;}
   }else if(action==='submit'){
    const draft=draftFor(interaction,id);
    if(draft.state!=='editing'||String(draft.page)!==pageText)throw Error('這一頁已送出，請勿重複提交');
    draft.state='processing';
    await interaction.deferReply({flags:64});
    try{
     const template=await load(draft.templateId);engine.validateTemplate(template,{organization,version:draft.version});
     const values=Object.fromEntries(draft.pages[draft.page].map((field)=>[field.key,interaction.fields.getTextInputValue(field.key)]));
     Object.assign(draft.values,engine.normalizeValues({fields:draft.pages[draft.page]},values));
     if(draft.page+1<draft.pages.length){draft.page++;draft.state='ready';await interaction.editReply({content:`已保存第 ${draft.page} 頁，請繼續填寫第 ${draft.page+1} 頁。`,components:[button(`svc:continue:${id}`,'繼續填寫')],allowedMentions:{parse:[]}});}
     else{await output(interaction,template,draft.values);drafts.delete(id);}
    }catch(error){drafts.delete(id);throw error;}
   }else{await interaction.reply({...privateMessage,content:'這個操作已失效，請從客服面板重新選擇。'});}
  }catch(error){
   const safe=error instanceof engine.ServiceTemplateError||error instanceof Error&&/請|模板|表單|欄位|頁|這份/.test(error.message)?error.message:'客服模板暫時無法使用，請稍後重試。';
   try{if(interaction.deferred||interaction.replied)await interaction.editReply({content:safe,components:[],allowedMentions:{parse:[]}});else await interaction.reply({...privateMessage,content:safe});}catch{console.warn('[客服模板] 無法回覆此互動，請重新操作');}
  }finally{
   if(shouldReset&&(interaction.replied||interaction.deferred)){
    await resetPanelSelection(interaction.message,customId);
   }
  }
  return true;
 }
 async function ensurePanel(){
  if(panelPromise)return panelPromise;
  panelPromise=(async()=>{
   const owner=randomUUID();const lease=await checked(supabase.rpc('lease_service_panel',{p_organization:organization,p_owner:owner}));if(!lease)return null;
   try{
    if(lease.channel_id!==store.channel||lease.guild_id!==store.guild)throw Error('客服面板登記的頻道不正確');
    const channel=await client.channels.fetch(store.channel);if(!channel||channel.guildId!==store.guild||!channel.isTextBased())throw Error('客服面板頻道不正確');
    const templates=await list();
    if(!templates.length)throw Error('客服模板尚未匯入');
    const components=[];
    if(giftOptions.length&&templates.some(template=>template.slug==='gift-broadcast'))components.push(giftMenu());
    const quick=QUICK_ACTIONS.flatMap(([slug,label])=>{
     const template=templates.find(item=>item.slug===slug);
     return template?[actionButton(`svc:quick:${template.id}`,label)]:[];
    });
    if(quick.length)components.push({type:1,components:quick});
    const sections=[
     {label:'直接選擇播報模板',items:templates.filter(template=>template.category==='播報')},
     {label:'直接選擇訂單協助或內部登記',items:templates.filter(template=>template.category!=='播報')},
    ];
    for(const {label,items} of sections){
     for(let start=0;start<items.length&&components.length<5;start+=25){
      components.push(row({type:3,custom_id:`svc:template:${components.length}`,placeholder:label,options:items.slice(start,start+25).map(template=>({
       label:template.title.slice(0,100),value:template.id,description:(template.description||template.category).slice(0,100),
      }))}));
     }
    }
    let message=null;
    if(lease.message_id){try{message=await channel.messages.fetch(lease.message_id);}catch(error){if(error.code!==10008)throw error;}if(message&&!isOurPanel(message))throw Error('客服面板紀錄不符合本機器人');}
    if(!message){const recent=await channel.messages.fetch({limit:100});message=[...recent.values()].find(isOurPanel)||null;}
    const data={embeds:[{
     title:`${store.name}｜客服操作面板`,
     description:'選擇本店打賞品項可直接帶入禮物名稱。也可點常用按鈕，或從同一則面板選擇播報、訂單協助與登記模板。\n產生的文字只會私下回覆給操作的客服。',
     color:organization==='qiunai'?0x7287df:0x68579c,footer:{text:friendlyFooter},
    }],components,allowedMentions:{parse:[]}};
    // Renew ownership immediately before touching Discord, then fence the DB save.
    const renewed=await checked(supabase.rpc('lease_service_panel',{p_organization:organization,p_owner:owner}));if(!renewed)return null;
    const created=!message;if(message)await editPanel(()=>message.edit(data));else message=await channel.send(data);
    const saved=await checked(supabase.from('service_panel_registry').update({message_id:message.id,updated_at:new Date(now()).toISOString()}).eq('organization_code',organization).eq('channel_id',store.channel).eq('lease_owner',owner).gt('lease_until',new Date(now()).toISOString()).select('message_id'));
    if(!saved.length){if(created&&isOurPanel(message))await message.delete();throw Error('客服面板租約已失效');}
    return message.id;
   }finally{await checked(supabase.from('service_panel_registry').update({lease_owner:null,lease_until:null}).eq('organization_code',organization).eq('lease_owner',owner));}
  })();
  try{return await panelPromise;}finally{panelPromise=null;}
 }
 return {ensurePanel,handleInteraction};
};
