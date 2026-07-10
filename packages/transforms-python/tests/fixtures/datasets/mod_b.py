from transforms.api import transform, Input, Output

@transform.using(output=Output("/b/out"), input=Input("/b/in"))
def clean_b(output, input):
    output.write_table(input.pandas())
