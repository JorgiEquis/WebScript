route("/estatica")

reactive contador = 0

style boton =
    -> background-color: #2563eb
    -> color: white
    -> border: none
    -> padding: 8px 16px

visual paginaEstatica =
<div class={boton} onclick={contador++}>
    <h1>Ruta estática</h1>
    <p>Contador: {contador}</p>
    if (contador == 0)
        <p>Todavia no le has dado al boton</p>
    else if (contador < 5)
        <p>Vas bien</p>
    else
        <p>Ya llevas unos cuantos</p>
</div>

render(
    paginaEstatica
)
