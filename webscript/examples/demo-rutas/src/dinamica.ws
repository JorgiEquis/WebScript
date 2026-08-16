route("/dinamica")

server var visitas = 100

post function incrementar(args)
    visitas = visitas + args.cantidad
    return { visitas: visitas }

reactive contadorCliente = server.visitas

style boton =
    -> background-color: #16a34a
    -> color: white
    -> border: none
    -> padding: 8px 16px

visual paginaDinamica =
<div class={boton} onclick={
    var r = await incrementar({ cantidad: 1 })
    contadorCliente = r.visitas
}>
    <h1>Ruta dinamica</h1>
    <p>Visitas segun el servidor: {contadorCliente}</p>
</div>

render(
    paginaDinamica
)
