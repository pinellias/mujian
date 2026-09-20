(function(){try{
  var R=document.documentElement;
  var t=localStorage.getItem('mujian_theme');
  if(t)R.setAttribute('data-theme',t);
  /* 装成应用后浏览器那圈工具栏的颜色：跟着主题走，取顶栏用的 --panel */
  var mc=document.getElementById('themeColorMeta');
  if(mc){var pc=getComputedStyle(R).getPropertyValue('--panel').trim();
    if(pc)mc.setAttribute('content',pc);}
  var F={yahei:'"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif',
    hei:'"SimHei","Heiti SC","STHeiti",sans-serif',
    kai:'"KaiTi","Kaiti SC","STKaiti",serif',
    wenkai:'"LXGW WenKai","KaiTi","Kaiti SC","STKaiti",serif',
    fang:'"FangSong","STFangsong","FangSong_GB2312",serif'};
  var f=localStorage.getItem('mujian_font');
  if(f&&F[f])R.style.setProperty('--script-font',F[f]);
  var s=parseInt(localStorage.getItem('mujian_fontsize'),10);
  if(s>=14&&s<=32)R.style.setProperty('--script-size',s+'px');
  /* 显示比例也在这里先套上，不然刷新时会先按 100% 画一遍再跳到上次的倍率 */
  var z=parseInt(localStorage.getItem('mujian_zoom'),10);
  if(z>=50&&z<=200)R.style.setProperty('--view-zoom',(z/100).toFixed(2));
}catch(e){}})();

/* 注册服务工作线程：启用 PWA「安装到主屏 / 独立模式」，从而隐藏浏览器工具栏。
   仅安全上下文（HTTPS 或 localhost）可用 —— 普通 http 局域网下会自动跳过，不影响正常使用。 */
(function(){
  try{
    if(!('serviceWorker' in navigator)) return;
    if(location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1') return;
    window.addEventListener('load',function(){
      navigator.serviceWorker.register('/sw.js').catch(function(e){ console.warn('[幕间] ServiceWorker 注册失败：',e); });
    });
  }catch(e){}
})();
