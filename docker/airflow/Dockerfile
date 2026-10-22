# Airflow 3 with the packages the pipeline needs.
FROM apache/airflow:3.3.2-python3.12

# Prophet ships prebuilt wheels (including its Stan backend) for Linux, so no
# compiler is needed. pandas and numpy already come with the Airflow image.
RUN pip install --no-cache-dir prophet requests python-dotenv
