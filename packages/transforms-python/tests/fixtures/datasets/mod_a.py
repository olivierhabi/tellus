from transforms.api import transform, Input, Output

@transform(output=Output("/a/out"), src=Input("/a/in"))
def clean_a(output, src):
    df = src.polars()
    output.write_table(df)
