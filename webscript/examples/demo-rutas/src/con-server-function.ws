route("/con-server-function")

server var totalConIva = 0

server function calcularIva(precio)
    return precio * 1.21

post function postController(args)
    var conIva = calcularIva(args.precio)
    totalConIva = totalConIva + conIva
    return { conIva: conIva, totalConIva: totalConIva }

reactive resultado = 0
reactive total = server.totalConIva

style boton =
    -> background-color: #7c3aed
    -> color: white
    -> border: none
    -> padding: 8px 16px

visual pagina =
<div class={boton} onclick={
    var r = await postController({ precio: 100 })
    resultado = r.conIva
    total = r.totalConIva
}>
    <h1>Con server function</h1>
    <p>Resultado: {resultado}</p>
    <p>Total acumulado: {total}</p>
</div>

render(
    pagina
)
