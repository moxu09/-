'use strict';
/** Shared by the web and Discord gateway. No network, HTML or executable templates.
 * Template: {id,organization_code,version,is_active,body,fields:[{key,label,
 * type:'text'|'paragraph'|'user'|'role'|'choice',required?,maxLength?,options?:string[]}]}
 * Keys are f0..f19. Metadata is ignored. compileTemplate returns a string;
 * {organization,version} are mandatory trusted scope/version expectations.
 */
const LIMITS = Object.freeze({fields:20,body:20000,output:30000,pageSize:5});
class ServiceTemplateError extends Error {constructor(message,code='INVALID_TEMPLATE'){super(message);this.name='ServiceTemplateError';this.code=code;}}
const fail=(message,code)=>{throw new ServiceTemplateError(message,code);};
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
function validateTemplate(template, {organization,version}={}) {
 if (!['qiunai','deepnight'].includes(organization)||!template||template.organization_code!==organization) fail('找不到此店家的模板','NOT_FOUND');
 const now=Date.now();
 if ((template.starts_at && (!Number.isFinite(Date.parse(template.starts_at)) || Date.parse(template.starts_at)>now)) || (template.ends_at && (!Number.isFinite(Date.parse(template.ends_at)) || Date.parse(template.ends_at)<=now))) fail('模板已到期或尚未開放','INACTIVE');
 if (template.is_active!==true) fail('模板已停用，請重新選擇','INACTIVE');
 if (!Number.isSafeInteger(version)||version<1||template.version!==version) fail('模板已更新，請重新選擇','STALE_VERSION');
 if (typeof template.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(template.id)||typeof template.body!=='string'||!template.body.length||template.body.length>LIMITS.body||!Array.isArray(template.fields)||template.fields.length>LIMITS.fields) fail('模板設定不正確');
 const keys=new Set();
 for (const field of template.fields) {
  if (!field||!/^f(?:[0-9]|1[0-9])$/.test(field.key)||keys.has(field.key)||typeof field.label!=='string'||!field.label.trim()||field.label.length>45||/[\r\n]/.test(field.label)||!['text','paragraph','user','role','choice'].includes(field.type)) fail('模板欄位設定不正確');
  if(field.required!==undefined&&typeof field.required!=='boolean')fail('模板欄位設定不正確');
  if(field.maxLength!==undefined&&(!Number.isInteger(field.maxLength)||field.maxLength<1||field.maxLength>4000))fail('模板欄位長度不正確');
  if(field.type==='choice'&&(!Array.isArray(field.options)||!field.options.length||field.options.length>25||new Set(field.options).size!==field.options.length||field.options.some(option=>typeof option!=='string'||!option.trim()||option!==option.trim()||option.length>100)))fail('模板選項設定不正確');
  keys.add(field.key);
 }
 const placeholders=[...template.body.matchAll(/\{\{([^{}]*)\}\}/g)];
 if (/\{\{|\}\}/.test(template.body.replace(/\{\{([^{}]*)\}\}/g,''))||placeholders.some(match=>!keys.has(match[1])))fail('模板包含未定義欄位');
 return template;
}
function normalizeDiscordMention(value,type) {
 const match=String(value).match(type==='role'?/^(?:([0-9]{15,22})|<@&([0-9]{15,22})>)$/:/^(?:([0-9]{15,22})|<@!?([0-9]{15,22})>)$/);
 if(!match)fail(type==='role'?'請輸入有效的 Discord 身分組 ID':'請輸入有效的 Discord 使用者 ID','INVALID_VALUE');
 return `<@${type==='role'?'&':''}${match[1]||match[2]}>`;
}
function normalizeValues(template,values) {
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(key=>!template.fields.some(field=>field.key===key)))fail('模板輸入欄位不正確','INVALID_VALUE');
 const result=Object.create(null);
 for(const field of template.fields) {
  let value=own(values,field.key)?values[field.key]:'';
  if(typeof value!=='string')fail('模板欄位必須是文字','INVALID_VALUE');
  value=value.trim();
  if(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)||(field.type!=='paragraph'&&/[\r\n]/.test(value)))fail('欄位包含不允許的字元','INVALID_VALUE');
  const max=field.maxLength||(field.type==='paragraph'?2000:field.type==='choice'?100:500);
  if(value.length>max)fail(`${field.label}超過長度上限`,'INVALID_VALUE');
  if(!value&&field.required)fail(`請填寫${field.label}`,'INVALID_VALUE');
  if(value&&['user','role'].includes(field.type))value=normalizeDiscordMention(value,field.type);
  if(value&&field.type==='choice'&&!field.options.includes(value))fail('請選擇有效的模板選項','INVALID_VALUE');
  result[field.key]=value;
 }
 return result;
}
function compileTemplate(template,values,options) {
 validateTemplate(template,options);
 const normalized=normalizeValues(template,values);
 const projected=template.body.replace(/\{\{([^{}]*)\}\}/g,'').length+[...template.body.matchAll(/\{\{([^{}]*)\}\}/g)].reduce((sum,match)=>sum+normalized[match[1]].length,0);
 if(projected>LIMITS.output)fail('產生的文字超過長度上限','INVALID_VALUE');
 const output=template.body.replace(/\{\{([^{}]*)\}\}/g,(_match,key)=>normalized[key]);
 if(output.length>LIMITS.output)fail('產生的文字超過長度上限','INVALID_VALUE');
 return output;
}
function templatePages(template,options) {
 validateTemplate(template,options);
 const pages=[];
 for(let start=0;start<template.fields.length;start+=LIMITS.pageSize)pages.push(template.fields.slice(start,start+LIMITS.pageSize));
 return pages.length?pages:[[]];
}
module.exports={ServiceTemplateError,LIMITS,validateTemplate,normalizeValues,normalizeDiscordMention,compileTemplate,templatePages};
