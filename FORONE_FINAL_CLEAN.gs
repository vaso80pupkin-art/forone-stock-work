const FORONE_SPREADSHEET_ID='1fanDUGGwc8rioi5cnkE1Xydpv3r1pq9L755YztUmLCQ';
const FORONE_CONFIG={sourceSheets:['Октябрь-Ноябрь'],targetSheet:'FORONE_Остатки',triggerFunction:'syncForoneStock',triggerMinutes:15};
const FORONE_HEADERS=['Артикул','Название','Категория','Длина','Остаток на складе','Резерв','Склад','Зона','Стеллаж','Ячейка','Доступно к продаже'];
function setupForoneAutomation(){
  const name=FORONE_CONFIG.triggerFunction;
  ScriptApp.getProjectTriggers().forEach(function(trigger){
    if(trigger.getHandlerFunction()===name) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(name).timeBased().everyMinutes(FORONE_CONFIG.triggerMinutes).create();
  syncForoneStock();
}
function syncForoneStock(){
  const spreadsheet=SpreadsheetApp.openById(FORONE_SPREADSHEET_ID);
  const target=getOrCreateSheet_(spreadsheet,FORONE_CONFIG.targetSheet);
  const preserved=readExistingTarget_(target);
  const merged=new Map();
  FORONE_CONFIG.sourceSheets.forEach(function(sheetName){
    const source=spreadsheet.getSheetByName(sheetName);
    if(!source) throw new Error('Не найден лист: '+sheetName);
    const values=source.getDataRange().getValues();
    const headerRow=findHeaderRow_(values);
    if(headerRow<0) throw new Error('Не найдены колонки Артикул и Остаток на складе на листе: '+sheetName);
    const columns=mapColumns_(values[headerRow]);
    for(let r=headerRow+1;r<values.length;r+=1){
      const item=readSourceItem_(values[r],columns);
      if(item&&!isSummaryItem_(item)) merged.set(makeKey_(item.sku,item.category,item.name),item);
    }
  });
  const output=Array.from(merged.values()).sort(function(a,b){
    const category=a.category.localeCompare(b.category,'ru');
    return category||a.sku.localeCompare(b.sku,'ru');
  }).map(function(item){
    const old=preserved.get(makeKey_(item.sku,item.category,item.name))||{};
    const reserve=Math.min(Math.max(0,toNumber_(old.reserve)),Math.max(0,item.stock));
    return [item.sku,item.name,item.category,item.length,item.stock,reserve,old.warehouse||'Алматы',old.zone||'',old.rack||'',old.bin||'',null];
  });
  target.clearContents();
  target.getRange(1,1,1,FORONE_HEADERS.length).setValues([FORONE_HEADERS]);
  if(output.length){
    target.getRange(2,1,output.length,FORONE_HEADERS.length).setValues(output);
    const formulas=output.map(function(_,index){return ['=E'+(index+2)+'-F'+(index+2)];});
    target.getRange(2,11,output.length,1).setFormulas(formulas);
  }
  formatTarget_(target,output.length+1);
  PropertiesService.getScriptProperties().setProperties({FORONE_LAST_SYNC:new Date().toISOString(),FORONE_LAST_COUNT:String(output.length)});
}
function getOrCreateSheet_(spreadsheet,name){return spreadsheet.getSheetByName(name)||spreadsheet.insertSheet(name);}
function readExistingTarget_(sheet){
  const result=new Map();
  if(sheet.getLastRow()<2)return result;
  const values=sheet.getRange(1,1,sheet.getLastRow(),FORONE_HEADERS.length).getValues();
  const columns=mapColumns_(values[0]);
  for(let r=1;r<values.length;r+=1){
    const row=values[r];
    const sku=text_(valueAt_(row,columns.sku));
    const name=text_(valueAt_(row,columns.name));
    const category=text_(valueAt_(row,columns.category));
    if(!sku||!name)continue;
    result.set(makeKey_(sku,category,name),{reserve:valueAt_(row,columns.reserve),warehouse:text_(valueAt_(row,columns.warehouse)),zone:text_(valueAt_(row,columns.zone)),rack:text_(valueAt_(row,columns.rack)),bin:text_(valueAt_(row,columns.bin))});
  }
  return result;
}
function findHeaderRow_(values){
  for(let r=0;r<Math.min(values.length,40);r+=1){
    const row=values[r].map(normalize_);
    const hasSku=row.some(function(value){return ['артикул','sku','код','article','номенклатура','colorno'].includes(value);});
    const hasStock=row.some(function(value){return ['остаток','остатокнаскладе','остатокпослепоступлениятовара','количество','колво','qty','stock','алматыналичии'].includes(value);});
    if(hasSku&&hasStock)return r;
  }
  return -1;
}
function mapColumns_(header){
  const names=header.map(normalize_);
  return {
    sku:findColumn_(names,['артикул','sku','код','article','номенклатура','colorno']),
    name:findColumn_(names,['название','наименование','товар','name','productname','описание']),
    category:findColumn_(names,['категория','тип','category']),
    length:findColumn_(names,['длина','размер','length']),
    stock:findColumn_(names,['остаток','остатокнаскладе','остатокпослепоступлениятовара','количество','колво','stock','qty','алматыналичии']),
    reserve:findColumn_(names,['резерв','зарезервировано','reserved']),
    warehouse:findColumn_(names,['склад','warehouse']),
    zone:findColumn_(names,['зона','zone']),
    rack:findColumn_(names,['стеллаж','rack']),
    bin:findColumn_(names,['ячейка','bin','cell'])
  };
}
function findColumn_(headers,aliases){
  for(let i=0;i<headers.length;i+=1)if(aliases.includes(headers[i]))return i;
  return -1;
}
function readSourceItem_(row,columns){
  const sku=text_(valueAt_(row,columns.sku));
  const name=text_(valueAt_(row,columns.name))||sku;
  if(!sku)return null;
  const categoryValue=text_(valueAt_(row,columns.category));
  const category=categoryValue||inferCategory_(name);
  const rawLength=valueAt_(row,columns.length);
  return {sku:sku,name:name,category:category,length:rawLength?parseLength_(rawLength):parseLength_(name),stock:Math.max(0,Math.round(toNumber_(valueAt_(row,columns.stock))))};
}
function isSummaryItem_(item){return /^(итого|всего|total)(\b|\s)/i.test(item.sku)||!item.name||item.name===item.sku;}
function inferCategory_(name){
  const value=name.toLowerCase();
  if(value.includes('лувер')||value.includes('louver'))return 'Лувер';
  if(value.includes('проф'))return 'Профиль';
  return 'Панель';
}
function parseLength_(value){
  const text=String(value||'').toLowerCase().replace(/\s+/g,' ');
  return /4000|(?:^|[^0-9])4\s*м(?:\b|$)|4\s*метр/.test(text)?4000:3000;
}
function makeKey_(sku,category,name){return [sku,category,name].map(normalize_).join('|');}
function normalize_(value){return String(value==null?'':value).toLowerCase().replace(/[\s_\-./№:()]/g,'');}
function text_(value){return String(value==null?'':value).trim();}
function valueAt_(row,index){return index>=0?row[index]:'';}
function toNumber_(value){
  if(typeof value==='number'&&isFinite(value))return value;
  const cleaned=text_(value).replace(/\s/g,'').replace(',','.').replace(/[^\d.-]/g,'');
  const parsed=Number(cleaned);
  return isFinite(parsed)?parsed:0;
}
function formatTarget_(sheet,rowCount){
  const oldFilter=sheet.getFilter();
  if(oldFilter)oldFilter.remove();
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,FORONE_HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#173b43');
  sheet.getRange(1,1,rowCount,FORONE_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1,FORONE_HEADERS.length);
  sheet.setColumnWidth(2,260);
  sheet.setColumnWidth(7,120);
  sheet.setColumnWidth(8,100);
  sheet.setColumnWidth(9,120);
  sheet.setColumnWidth(10,120);
}