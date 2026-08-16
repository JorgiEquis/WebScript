route("/panel")

server var visitas = 42

post function incrementar(args)
    visitas = visitas + args.cantidad
    return { visitas: visitas }

reactive contadorCliente = server.visitas

style boton =
    -> background-color: purple
    -> color: white

visual panelServidor =
<div class={boton} onclick={
    var r = await incrementar({ cantidad: 1 })
    contadorCliente = r.visitas
}>
    <h1>Panel</h1>
    <p>Visitas (servidor): {contadorCliente}</p>
</div>

render(
    panelServidor
)
