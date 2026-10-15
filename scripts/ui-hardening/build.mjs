// Optional browser tools live outside the application dependency graph.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const out=process.env.FM_UI_BROWSER_OUTPUT || '/tmp/fm-ui-browser';
const external=createRequire(path.resolve(process.env.FM_UI_BROWSER_TOOLS || '/tmp/fm-ui-browser','package.json'));
const require=createRequire(path.join(root,'package.json'));
const {build}=external('esbuild');
fs.mkdirSync(out,{recursive:true});
await build({entryPoints:[path.join(root,'scripts/ui-hardening/fixture.tsx')],outfile:path.join(out,'fixture.js'),bundle:true,jsx:'automatic',alias:{'@':root,react:root+'/node_modules/react','react-dom':root+'/node_modules/react-dom'},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'presentation-only-reasons',setup(b){b.onLoad({filter:/[/\\]lib[/\\]audit\.ts$/},()=>{const source=fs.readFileSync(path.join(root,'lib/audit.ts'),'utf8');const reasons=source.match(/export const OPERATOR_REASON_CODES = (\[[\s\S]*?\]) as const;/);if(!reasons)throw new Error('Reason vocabulary not found');return {contents:'export const OPERATOR_REASON_CODES = '+reasons[1]+';',loader:'js'};});}}]});
const result=await require('postcss')([require('@tailwindcss/postcss')()]).process(fs.readFileSync(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'});
fs.writeFileSync(path.join(out,'style.css'),result.css);
fs.writeFileSync(path.join(out,'index.html'),'<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
console.log('UI-only fixture written to',out);
