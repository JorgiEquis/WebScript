route("/dinamica")

server var visitas = 100

reactive contadorCliente = server.visitas

style boton =
    -> background-color: #16a34a
    -> color: white
    -> border: none
    -> padding: 8px 16px

visual paginaDinamica =
<div>
    <h1>Ruta dinamica</h1>
    <p>Visitas segun el servidor: {contadorCliente}</p>
</div>
    -> style: boton
    -> onclick:
        contadorCliente = await updateServer({ visitas: contadorCliente + 1 }).then(s => s.visitas)

render(
    paginaDinamica
)
