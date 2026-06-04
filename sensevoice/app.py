import os
import re
import shutil
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from funasr import AutoModel

app = FastAPI()

# Cache directory configuration
os.environ["MODELSCOPE_CACHE"] = "/app/modelscope_cache"

print("Loading SenseVoiceSmall model...")
model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", disable_update=True)
print("Model loaded successfully!")

@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form("whisper-1", alias="model")
):
    # Save file temporarily
    temp_file = f"temp_{file.filename}"
    with open(temp_file, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    try:
        # Run inference using SenseVoiceSmall
        res = model.generate(
            input=temp_file,
            cache={},
            language="auto",
            use_itn=True,
            batch_size_s=300,
        )
        
        if res and len(res) > 0:
            text = res[0].get("text", "")
            # Strip language/emotion/speech tags like <|zh|><|NEUTRAL|><|Speech|>
            text = re.sub(r'<\|.*?\|>', '', text).strip()
            return {"text": text}
        return {"text": ""}
    except Exception as e:
        print(f"Error during transcription: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception:
                pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
