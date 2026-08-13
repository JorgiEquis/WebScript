route("/formulario-input")

server var mensajes = []

post function postController(args)
    mensajes = [...mensajes, args.texto]
    return { total: mensajes.length }

reactive texto = ""
reactive total = 0

style boton =
    -> background-color: teal
    -> color: white

visual campoTexto =
<input placeholder="Escribe algo">
    -> oninput:
        texto = event.target.value

visual botonEnviar =
<button>
    Enviar
</button>
    -> style: boton
    -> onclick:
        var r = await postController({ texto: texto })
        total = r.total
        texto = ""

visual pagina =
<div>
    <campoTexto />
    <botonEnviar />
    <p>Total enviados: {total}</p>
</div>

render(
    pagina
)
