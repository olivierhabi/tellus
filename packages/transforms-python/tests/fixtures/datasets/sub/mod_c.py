from transforms.api import transform, Input, Output

@transform.spark.using(output=Output("/c/out"), input=Input("/c/in"))
def clean_c(output, input):
    output.write_table(input.polars())
