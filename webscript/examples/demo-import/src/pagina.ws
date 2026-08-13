route("/")

import { botonPrimario, encabezado, calcularIva } from "./compartido.ws"

reactive precio = 100
reactive resultado = 0

post function postController(args)
    var conIva = calcularIva(args.precio)
    return { conIva: conIva }

visual boton =
<button>
    Calcular
</button>
    -> style: botonPrimario
    -> onclick:
        var r = await postController({ precio: precio })
        resultado = r.conIva

visual paginaPrincipal =
<div>
    <encabezado />
    <p>Precio: {precio}</p>
    <p>Con IVA: {resultado}</p>
    <boton />
</div>

render(
    paginaPrincipal
)
