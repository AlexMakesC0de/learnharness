import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
test("the actual microphone worklet flushes its incomplete PCM frame exactly once before acknowledging stop", () => {
 const packets: {type:string;buffer?:Int16Array}[]=[];
 let Processor!: new()=>{process(inputs:Float32Array[][]):boolean;port:{onmessage:(event:{data:{type:string}})=>void}};
 class Worklet {port={postMessage:(packet:{type:string;buffer?:Int16Array})=>packets.push(packet)};}
 runInNewContext(readFileSync(new URL("../public/worklets/pcm-capture.js",import.meta.url),"utf8"),{AudioWorkletProcessor:Worklet,registerProcessor:(_name:string,ctor:typeof Processor)=>{Processor=ctor;}});
 const capture=new Processor();capture.process([[new Float32Array([0.5,-0.5,1,-1])]]);
 assert.equal(packets.filter(packet=>packet.type==="audio").length,0);
 capture.port.onmessage({data:{type:"flush"}});
 const audio=packets.find(packet=>packet.type==="audio");assert.deepEqual([...audio!.buffer!],[16383,-16384,32767,-32768]);
 assert.equal(packets.at(-1)?.type,"flushed");capture.port.onmessage({data:{type:"flush"}});
 assert.equal(packets.filter(packet=>packet.type==="audio").length,1);
});
