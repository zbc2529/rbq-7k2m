(function(RBQ, $, toastr) {
    if (!RBQ) return console.error('RBQ Core API 缺失!');
    
    console.info("🌸 Hello from RBQ-Draw HelloWorld Sub-Plugin! 🌸");
    
    // 监听白嫖渠道的钩子
    RBQ.on('buildGeneratePayload', (payload) => {
        toastr.success("Hello World 子插件：拦截到了【白嫖渠道】的绘画请求！");
        console.log("拦截到的白嫖请求参数为: ", payload);
        return payload; 
    });

    // 监听 NAI 直连模式的钩子
    RBQ.on('buildNaiV4Payload', (payload) => {
        toastr.success("Hello World 子插件：拦截到了【NAI】的绘画请求！");
        console.log("拦截到的 NAI 请求参数为: ", payload);
        return payload; 
    });

})(RBQ, jQuery, toastr);
