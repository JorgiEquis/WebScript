reactive base = 10

function calcularConBase(x)
    var resultado = x + base
    if (resultado > 20)
        return "alto: " + resultado
    else
        return "bajo: " + resultado

visual v =
<p>{calcularConBase(15)}</p>

render(
    v
)
